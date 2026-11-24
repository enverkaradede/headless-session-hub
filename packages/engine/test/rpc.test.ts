import type { Caller, PeerAccess, TimelineEvent } from "@hub/protocol";
import { describe, expect, it } from "vitest";
import { maskTimelineForPeer, RpcDispatcher } from "../src/rpc.ts";
import { SettingsService } from "../src/settings.ts";
import { ACTOR, makeHarness, msg, waitFor } from "./helpers.ts";

const peer = (access: PeerAccess): Caller => ({ kind: "peer", deviceId: "device-0123456789abcdef", deviceName: "office-pc", access });

function harnessWithRpc() {
  const h = makeHarness([
    async function* (ctx) {
      await ctx.nextUserText();
      yield msg.init();
      await ctx.askHook()(
        { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Q?", header: "Q", options: [{ label: "a" }, { label: "b" }], multiSelect: false }] }, tool_use_id: "tu", session_id: "s", transcript_path: "", cwd: "" } as never,
        "tu",
        { signal: new AbortController().signal },
      );
      yield msg.result("ok");
      await ctx.nextUserText();
    },
  ]);
  const settings = new SettingsService(h.store);
  settings.update({ allowedDirectories: [h.workDir] });
  const rpc = new RpcDispatcher({
    manager: h.manager,
    settings,
    info: () => ({ protocolVersion: 1, engineVersion: "t", hostname: "h", platform: "darwin", claudePath: "/secret/path", claudeVersion: "x", auth: [], apiPort: 1234 }),
    refreshAuth: async () => [],
    hubctlPath: null,
  });
  return { ...h, rpc, settings };
}

async function openQuestion(h: ReturnType<typeof harnessWithRpc>) {
  const session = await h.manager.start({ cwd: h.workDir, prompt: "ask" }, ACTOR);
  await waitFor(() => h.manager.requests(session.id).length === 1);
  const request = h.manager.requests(session.id)[0]!;
  return { sessionId: session.id, requestId: request.id, answer: { kind: "question", answers: { "Q?": "a" } } };
}

describe("RPC authorization by device access level", () => {
  it("returns FORBIDDEN and audits when a read-only device tries to answer", async () => {
    const h = harnessWithRpc();
    const params = await openQuestion(h);
    await expect(h.rpc.dispatch("sessions.answer", params, peer("read_only"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const entry = h.store.auditList(5).find((candidate) => candidate.action === "rpc.forbidden");
    expect(entry).toMatchObject({ detail: "sessions.answer" });
    expect(entry?.actor).toContain("office-pc");
    expect(h.manager.requests(params.sessionId)[0]?.state).toBe("open");
  });

  it("lets an operator device answer, attributing the answer to that device", async () => {
    const h = harnessWithRpc();
    const params = await openQuestion(h);
    await h.rpc.dispatch("sessions.answer", params, peer("operator"));
    const entry = h.store.auditList(10).find((candidate) => candidate.action === "request.answer");
    expect(entry?.actor).toBe("peer:office-pc#device-01234(operator)");
  });

  it("keeps settings changes to full-access devices and the local UI", async () => {
    const h = harnessWithRpc();
    await expect(h.rpc.dispatch("settings.update", { warmIdleMinutes: 5 }, peer("operator"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.rpc.dispatch("settings.update", { warmIdleMinutes: 5 }, { kind: "api" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.rpc.dispatch("settings.update", { warmIdleMinutes: 5 }, peer("full"))).resolves.toMatchObject({ warmIdleMinutes: 5 });
    await expect(h.rpc.dispatch("settings.update", { warmIdleMinutes: 7 }, { kind: "local" })).resolves.toMatchObject({ warmIdleMinutes: 7 });
  });

  it("lets read-only devices observe", async () => {
    const h = harnessWithRpc();
    await openQuestion(h);
    await expect(h.rpc.dispatch("sessions.list", {}, peer("read_only"))).resolves.toHaveLength(1);
  });

  it("never sends webhook secrets or the local claude path to any peer", async () => {
    const h = harnessWithRpc();
    const secret = "a-very-long-webhook-secret-value";
    h.settings.update({ webhooks: [{ id: "00000000-0000-4000-8000-000000000001", url: "https://example.test/hook", events: ["session.completed"], secret, enabled: true }] });
    const forPeer = JSON.stringify(await h.rpc.dispatch("settings.get", {}, peer("full")));
    expect(forPeer).not.toContain(secret);
    const info = (await h.rpc.dispatch("engine.info", {}, peer("full"))) as { claudePath: unknown; apiPort: unknown };
    expect(info).toMatchObject({ claudePath: null, apiPort: null });
  });

  it("keeps an existing webhook secret when a full-access device saves the redacted value back", async () => {
    const h = harnessWithRpc();
    const secret = "original-secret-value-123";
    const hook = { id: "00000000-0000-4000-8000-000000000002", url: "https://example.test/hook", events: ["session.error" as const], secret, enabled: true };
    h.settings.update({ webhooks: [hook] });
    const redacted = h.settings.redacted();
    await h.rpc.dispatch("settings.update", { webhooks: redacted.webhooks }, peer("full"));
    expect(h.settings.get().webhooks[0]?.secret).toBe(secret);
  });

  it("rejects malformed params with BAD_REQUEST before touching state", async () => {
    const h = harnessWithRpc();
    await expect(h.rpc.dispatch("sessions.get", { sessionId: "not-a-uuid" }, { kind: "local" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(h.rpc.dispatch("no.such.method", {}, { kind: "local" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("peer egress masking", () => {
  const event = (kind: TimelineEvent["kind"], text: string, data: unknown = null): TimelineEvent => ({
    seq: 1, sessionId: "00000000-0000-4000-8000-000000000000", ts: 0, kind, text, toolName: null, toolUseId: null, data,
  });

  it("masks secrets in timeline text and data", () => {
    const masked = maskTimelineForPeer(event("tool_use", "export API_TOKEN=abcdef123456", { command: "curl -H 'Authorization: Bearer abcdefghijklmnop'" }), false);
    expect(JSON.stringify(masked)).not.toMatch(/abcdef123456|abcdefghijklmnop/);
  });

  it("drops tool traffic entirely in summary-only mode but keeps results", () => {
    expect(maskTimelineForPeer(event("tool_use", "rm -rf build"), true)).toBeNull();
    expect(maskTimelineForPeer(event("assistant_text", "thinking out loud"), true)).toBeNull();
    expect(maskTimelineForPeer(event("result", "Finished", { costUsd: 1 }), true)).toMatchObject({ text: "Finished", data: null });
  });
});
