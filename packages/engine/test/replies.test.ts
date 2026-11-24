import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CompatLayer } from "../src/hooks/compat.ts";
import { ACTOR, makeHarness, msg, waitFor } from "./helpers.ts";

const sdk = (value: Record<string, unknown>) => value as unknown as SDKMessage;

describe("plain-text questions (app sessions)", () => {
  it("shows a turn that ends on a question as waiting for a reply, and the reply continues it", async () => {
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        yield msg.text("I found two configs.\n\nShould I keep the staging one?");
        yield msg.result("I found two configs.\n\nShould I keep the staging one?");
        expect(await ctx.nextUserText()).toBe("Yes, keep it.");
        yield msg.text("Kept staging.");
        yield msg.result("Kept staging.");
        await ctx.nextUserText();
      },
    ]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "clean configs" }, ACTOR);
    await waitFor(() => h.manager.get(session.id).awaitingReply);
    expect(h.manager.get(session.id).status).toBe("waiting_input");
    expect(h.lifecycle.map((entry) => entry.event)).toContain("session.waiting");
    expect(h.lifecycle.map((entry) => entry.event)).not.toContain("session.completed");

    await h.manager.message(session.id, "Yes, keep it.", ACTOR);
    await waitFor(() => h.manager.get(session.id).status === "done");
    expect(h.manager.get(session.id).awaitingReply).toBe(false);
  });

  it("asks app sessions to use AskUserQuestion unless the owner turned it off", async () => {
    const script = async function* (ctx: { nextUserText(): Promise<string | null> }) {
      await ctx.nextUserText();
      yield msg.result("ok");
      await ctx.nextUserText();
    };
    const on = makeHarness([script]);
    await on.manager.start({ cwd: on.workDir, prompt: "x" }, ACTOR);
    expect(JSON.stringify(on.fake.calls[0]?.systemPrompt)).toContain("AskUserQuestion");

    const off = makeHarness([script], { settings: { askViaTool: false } });
    await off.manager.start({ cwd: off.workDir, prompt: "x" }, ACTOR);
    expect(off.fake.calls[0]?.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  });
});

describe("session defaults and live configuration", () => {
  it("uses the default model and permission mode from settings", async () => {
    const h = makeHarness(
      [
        async function* (ctx) {
          await ctx.nextUserText();
          await ctx.nextUserText();
        },
      ],
      { settings: { defaultModel: "sonnet", defaultPermissionMode: "acceptEdits" } },
    );
    const session = await h.manager.start({ cwd: h.workDir, prompt: "x" }, ACTOR);
    expect(h.fake.calls[0]).toMatchObject({ model: "sonnet", permissionMode: "acceptEdits" });
    expect(session).toMatchObject({ model: "sonnet", permissionMode: "acceptEdits" });
  });

  it("switches model and permission mode on a running process and keeps them for resumes", async () => {
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        yield msg.init();
        await ctx.nextUserText();
      },
    ]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "x" }, ACTOR);
    // Real order: the CLI's init (model as started) arrives before the owner changes anything.
    await waitFor(() => h.manager.get(session.id).model === "claude-test");
    const calls: string[] = [];
    const query = (h.manager as unknown as { live: Map<string, { query: Record<string, unknown> }> }).live.get(session.id)!.query;
    query.setModel = async (model?: string) => void calls.push(`model:${model}`);
    query.setPermissionMode = async (mode: string) => void calls.push(`mode:${mode}`);

    await h.manager.configure(session.id, { model: "opus", permissionMode: "plan" }, ACTOR);
    expect(calls).toEqual(["model:opus", "mode:plan"]);
    expect(h.manager.get(session.id)).toMatchObject({ model: "opus", permissionMode: "plan" });
    expect(h.store.getSession(session.id)?.launch).toMatchObject({ model: "opus", permissionMode: "plan" });
  });
});

describe("claude -p sessions via hooks", () => {
  const sessionId = "22222222-2222-4222-8222-222222222222";
  let hookCwd = "/tmp/project-not-allowed";
  const envelope = (event: string, payload: Record<string, unknown> = {}) => ({
    event: event as never,
    entrypoint: "sdk-cli",
    hubRun: null,
    payload: { session_id: sessionId, transcript_path: "/tmp/t.jsonl", cwd: hookCwd, hook_event_name: event, ...payload },
  });

  it("fills model, preview, tokens and cost, and keeps a plain-text question open after the process exits", async () => {
    const h = makeHarness([
      async function* (ctx) {
        expect(await ctx.nextUserText()).toBe("Use the staging config.");
        yield msg.result("done");
        await ctx.nextUserText();
      },
    ], { settings: { warmIdleMinutes: 0 } });
    hookCwd = h.workDir; // inside the allowlist, so the reply may resume it
    const usage = { inputTokens: 1200, outputTokens: 80, model: "claude-haiku-5-5" };
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings(), async () => usage);
    const signal = new AbortController().signal;

    await compat.handle(envelope("SessionStart", { model: "claude-sonnet-5-5" }), signal);
    expect(h.manager.get(sessionId).model).toBe("claude-sonnet-5-5");

    await compat.handle(envelope("Stop", { last_assistant_message: "Two configs exist.\nWhich one should I use?" }), signal);
    expect(h.manager.get(sessionId)).toMatchObject({ status: "waiting_input", awaitingReply: true, lastMessagePreview: "Two configs exist. Which one should I use?" });

    await compat.handle(envelope("SessionEnd", { reason: "other" }), signal);
    await waitFor(() => h.manager.get(sessionId).inputTokens === 1200);
    expect(h.manager.get(sessionId)).toMatchObject({ status: "waiting_input", awaitingReply: true, outputTokens: 80 });

    await compat.handle(envelope("RunResult", { total_cost_usd: 0.0123 }), signal);
    expect(h.manager.get(sessionId).costUsd).toBe(0.0123);

    // The reply resumes the ended claude -p session inside the hub.
    await h.manager.message(sessionId, "Use the staging config.", ACTOR);
    expect(h.fake.calls[0]?.resume).toBe(sessionId);
    await waitFor(() => h.manager.get(sessionId).status === "done" && !h.manager.get(sessionId).awaitingReply);
  });

  it("will not resume a claude -p session outside the allowed directories", async () => {
    // An existing directory that is not inside the harness allowlist (its own temp workDir).
    hookCwd = realpathSync(tmpdir());
    const h = makeHarness([]);
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings());
    const signal = new AbortController().signal;
    await compat.handle(envelope("SessionStart"), signal);
    await compat.handle(envelope("Stop", { last_assistant_message: "Which one?" }), signal);
    await compat.handle(envelope("SessionEnd", { reason: "other" }), signal);
    await expect(h.manager.message(sessionId, "the first", ACTOR)).rejects.toMatchObject({ code: "DIRECTORY_NOT_ALLOWED" });
    expect(h.fake.calls).toHaveLength(0);
  });

  it("still refuses to message a claude -p session whose process is running", async () => {
    const h = makeHarness([]);
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings());
    await compat.handle(envelope("SessionStart"), new AbortController().signal);
    await expect(h.manager.message(sessionId, "hi", ACTOR)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not treat a plain statement as a question", async () => {
    const h = makeHarness([]);
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings());
    await compat.handle(envelope("SessionStart"), new AbortController().signal);
    await compat.handle(envelope("Stop", { last_assistant_message: "All tests pass." }), new AbortController().signal);
    expect(h.manager.get(sessionId)).toMatchObject({ status: "idle", awaitingReply: false });
  });
});

export { sdk };
