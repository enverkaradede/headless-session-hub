import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import type { WebhookConfig } from "@hub/protocol";
import { describe, expect, it } from "vitest";
import { CompatLayer } from "../src/hooks/compat.ts";
import { healHooks, hookCommand, hooksInstalled, inspectHooks, installHooks, parseHubHook, uninstallHooks } from "../src/hooks/install.ts";
import { buildPayload, signPayload, WebhookDispatcher } from "../src/webhooks.ts";
import { ACTOR, makeHarness, waitFor } from "./helpers.ts";

const HUBCTL = "/Applications/Session Hub.app/Contents/MacOS/hubctl";

function profileDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-profile-"));
  return { dir, profile: { id: "p", name: "P", configDir: dir }, file: path.join(dir, "settings.json") };
}

describe("hook installation", () => {
  it("adds all five hooks, keeps the user's own hooks, and is idempotent", async () => {
    const { profile, file } = profileDir();
    const userHook = { type: "command", command: "my-linter --check" };
    writeFileSync(file, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [userHook] }] } }));
    await installHooks(profile, HUBCTL);
    await installHooks(profile, HUBCTL);
    const settings = JSON.parse(readFileSync(file, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0]).toEqual(userHook);
    expect(settings.hooks.PermissionRequest).toEqual([{ matcher: "*", hooks: [{ type: "command", command: hookCommand(HUBCTL, "PermissionRequest", "darwin"), timeout: 600 }] }]);
    expect(await hooksInstalled(profile)).toBe(true);
    expect(readFileSync(`${file}.session-hub.bak`, "utf8")).toContain("my-linter");
  });

  it("uninstall removes only the hub's hooks", async () => {
    const { profile, file } = profileDir();
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }] } }));
    await installHooks(profile, HUBCTL);
    await uninstallHooks(profile);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }] } });
    expect(await hooksInstalled(profile)).toBe(false);
  });

  it("refuses to touch a settings file that is not valid JSON", async () => {
    const { profile, file } = profileDir();
    writeFileSync(file, "{ broken");
    await expect(installHooks(profile, HUBCTL)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(file, "utf8")).toBe("{ broken");
  });

  it("writes Windows paths with forward slashes, guarded so a missing hubctl is skipped", () => {
    expect(hookCommand("C:\\Program Files\\Session Hub\\hubctl.exe", "Stop", "win32")).toBe(
      "if [ -f 'C:/Program Files/Session Hub/hubctl.exe' ]; then 'C:/Program Files/Session Hub/hubctl.exe' hook Stop; fi",
    );
  });

  it("reads back both the guarded form and the unguarded 0.1.x form", () => {
    const odd = "/Users/o'neil/Session Hub/hubctl";
    expect(parseHubHook(hookCommand(odd, "Notification", "darwin"))).toEqual({ hubctlPath: odd, event: "Notification", legacy: false });
    expect(parseHubHook('"C:/Program Files/Session Hub/hubctl.exe" hook SessionStart')).toEqual({ hubctlPath: "C:/Program Files/Session Hub/hubctl.exe", event: "SessionStart", legacy: true });
    expect(parseHubHook("my-linter --check")).toBeNull();
  });
});

/** A stand-in hubctl that prints its arguments, at a path with a space and a quote in it. */
function fakeHubctl(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "hub-bin-")), "Session Hub's bin");
  mkdirSync(dir);
  const file = path.join(dir, "hubctl");
  writeFileSync(file, '#!/bin/sh\necho "ran: $*"\n');
  chmodSync(file, 0o755);
  return file;
}

const runHook = (command: string) => execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe.skipIf(process.platform === "win32")("hook command in a real shell", () => {
  it("runs hubctl when it exists, even with a space and a quote in its path", () => {
    expect(runHook(hookCommand(fakeHubctl(), "SessionStart"))).toBe("ran: hook SessionStart\n");
  });

  it("succeeds silently when hubctl is gone, so Claude sessions never fail on it", () => {
    expect(runHook(hookCommand("/nonexistent/Session Hub/hubctl", "SessionStart"))).toBe("");
  });
});

describe("hook health and repair", () => {
  const legacy = (hubctlPath: string) =>
    Object.fromEntries(["SessionStart", "SessionEnd", "Stop", "Notification", "PermissionRequest"].map((event) => [event, [{ hooks: [{ type: "command", command: `"${hubctlPath}" hook ${event}` }] }]]));

  it("reports hooks that run a missing hubctl as broken, and repairs them to this install", async () => {
    const { profile, file } = profileDir();
    const gone = legacy("/gone/Session Hub/hubctl");
    writeFileSync(file, JSON.stringify({ hooks: { ...gone, Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }, ...(gone.Stop ?? [])] } }));
    expect(await inspectHooks(profile)).toMatchObject({ installed: true, health: "broken" });

    const current = fakeHubctl();
    expect(await healHooks(profile, current, "darwin")).toBe(true);
    const report = await inspectHooks(profile);
    expect(report.health).toBe("ok");
    expect(report.hooks.every((hook) => hook.hubctlPath === current && !hook.legacy)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.Stop[0].hooks[0].command).toBe("keep-me");
    expect(await healHooks(profile, current, "darwin")).toBe(false);
  });

  it("upgrades this install's unguarded hooks to the guarded form", async () => {
    const { profile } = profileDir();
    const current = fakeHubctl();
    writeFileSync(path.join(profile.configDir, "settings.json"), JSON.stringify({ hooks: legacy(current) }));
    expect(await healHooks(profile, current, "darwin")).toBe(true);
    expect((await inspectHooks(profile)).hooks.some((hook) => hook.legacy)).toBe(false);
  });

  it("leaves hooks that run another install's existing hubctl alone", async () => {
    const { profile, file } = profileDir();
    const other = fakeHubctl();
    await installHooks(profile, other);
    const before = readFileSync(file, "utf8");
    expect(await healHooks(profile, fakeHubctl(), "darwin")).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("does nothing for a profile without hub hooks", async () => {
    const { profile } = profileDir();
    expect(await healHooks(profile, fakeHubctl(), "darwin")).toBe(false);
    expect(await inspectHooks(profile)).toMatchObject({ installed: false, health: "not_installed" });
  });
});

describe("webhooks", () => {
  const target: WebhookConfig = { id: "00000000-0000-4000-8000-000000000009", url: "https://example.test/h", events: ["session.completed"], secret: "s".repeat(32), enabled: true };

  it("signs timestamp.body with HMAC-SHA256", () => {
    const expected = createHmac("sha256", target.secret).update("1700000000.{}").digest("hex");
    expect(signPayload(target.secret, "1700000000", "{}")).toBe(`sha256=${expected}`);
  });

  it("retries 5xx with backoff up to four attempts, never 4xx", async () => {
    const calls: number[] = [];
    const sleeps: number[] = [];
    let status = 503;
    const fetchImpl = (async () => {
      calls.push(status);
      return new Response(null, { status });
    }) as typeof fetch;
    const dispatcher = new WebhookDispatcher(() => ({}) as never, fetchImpl, async (ms) => void sleeps.push(ms), () => 1_700_000_000);
    expect(await dispatcher.deliver(target, "{}")).toBe(false);
    expect(calls).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
    calls.length = 0;
    status = 400;
    expect(await dispatcher.deliver(target, "{}")).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("masks secrets in the payload's last message", () => {
    const payload = buildPayload("session.completed", { name: "n", labels: [], status: "done", endReason: "completed", origin: "app", costUsd: 0, inputTokens: 0, outputTokens: 0, usageLimit: null, id: "x" } as never, "DB_PASSWORD=hunter2hunter2", new Date(0));
    expect(payload.session.lastMessage).not.toContain("hunter2");
  });
});

describe("compat layer (claude -p via hooks)", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const envelope = (event: string, entrypoint: string | null, payload: Record<string, unknown> = {}) => ({
    event: event as never,
    entrypoint,
    hubRun: null,
    payload: { session_id: sessionId, transcript_path: "/tmp/t.jsonl", cwd: "/tmp/project", hook_event_name: event, ...payload },
  });

  it("ignores interactive terminal sessions", async () => {
    const h = makeHarness([]);
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings());
    await compat.handle(envelope("SessionStart", "cli"), new AbortController().signal);
    expect(h.manager.store.getSession(sessionId)).toBeNull();
  });

  it("tracks a claude -p run from start to end and answers its permission request", async () => {
    const h = makeHarness([]);
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings());
    const signal = new AbortController().signal;
    await compat.handle(envelope("SessionStart", "sdk-cli"), signal);
    expect(h.manager.get(sessionId)).toMatchObject({ origin: "hook", status: "running" });

    const decision = compat.handle(envelope("PermissionRequest", "sdk-cli", { tool_name: "Bash", tool_input: { command: "touch x" } }), signal);
    await waitFor(() => h.manager.requests(sessionId).some((request) => request.state === "open"));
    expect(h.manager.get(sessionId).status).toBe("waiting_permission");
    const request = h.manager.requests(sessionId)[0]!;
    await h.manager.answer(sessionId, request.id, { kind: "permission", decision: "deny", message: "no" }, ACTOR);
    expect(await decision).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no" } } });

    await compat.handle(envelope("SessionEnd", "sdk-cli", { reason: "other" }), signal);
    expect(h.manager.get(sessionId)).toMatchObject({ status: "done", endReason: "completed" });
  });

  it("leaves the app's own SDK sessions to canUseTool", async () => {
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        await ctx.nextUserText();
      },
    ]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "x" }, ACTOR);
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings());
    const result = await compat.handle({ ...envelope("PermissionRequest", "sdk-ts", { tool_name: "Bash", tool_input: {} }), payload: { session_id: session.id, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: {} } }, new AbortController().signal);
    expect(result).toEqual({});
    expect(h.manager.requests(session.id)).toHaveLength(0);
  });
});
