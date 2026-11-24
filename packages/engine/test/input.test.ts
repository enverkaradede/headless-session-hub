/** Input is never locked: a message answers an open card, or waits in a queue until the session can take it. */
import type { CanUseTool, HookJSONOutput, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { CompatLayer } from "../src/hooks/compat.ts";
import { ACTOR, hookInput, makeHarness, msg, waitFor } from "./helpers.ts";

const signal = () => new AbortController().signal;

function callCanUseTool(canUseTool: CanUseTool | undefined, toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
  if (!canUseTool) throw new Error("canUseTool missing");
  return canUseTool(toolName, input, { signal: signal(), toolUseID: `tu-${toolName}`, requestId: "r" } as never) as Promise<PermissionResult>;
}

describe("messages while a card is open (app sessions)", () => {
  it("answers an open question with the typed message instead of queueing it behind the card", async () => {
    const outputs: HookJSONOutput[] = [];
    const pushedAfterQuestion: (string | null)[] = [];
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        yield msg.init();
        outputs.push(await ctx.askHook()(hookInput("tu-ask"), "tu-ask", { signal: signal() }));
        yield msg.result("ok");
        pushedAfterQuestion.push(await ctx.nextUserText());
      },
    ], { settings: { warmIdleMinutes: 0 } });
    const session = await h.manager.start({ cwd: h.workDir, prompt: "ask me" }, ACTOR);
    await waitFor(() => h.manager.get(session.id).status === "waiting_input");

    await h.manager.message(session.id, "Neither, use green.", ACTOR);
    await waitFor(() => outputs.length === 1);

    expect(outputs[0]).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("Neither, use green.") } });
    expect(h.store.requestsForSession(session.id)[0]?.state).toBe("cancelled");
    // The text went to Claude through the card, not a second time through the input stream.
    await waitFor(() => pushedAfterQuestion.length === 1);
    expect(pushedAfterQuestion[0]).toBeNull();
    const userMessages = h.store.timeline(session.id, 0, 1000).filter((event) => event.kind === "user_message").map((event) => event.text);
    expect(userMessages).toEqual(["ask me", "Neither, use green."]);
  });

  it("turns a message into a denial with the message as feedback for an open permission request", async () => {
    const results: PermissionResult[] = [];
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        yield msg.init();
        results.push(await callCanUseTool(ctx.options.canUseTool, "Bash", { command: "rm -rf build" }));
        yield msg.result("ok");
        await ctx.nextUserText();
      },
    ]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "clean" }, ACTOR);
    await waitFor(() => h.manager.get(session.id).status === "waiting_permission");

    await h.manager.message(session.id, "Only delete build/tmp.", ACTOR);
    await waitFor(() => results.length === 1);
    expect(results[0]).toMatchObject({ behavior: "deny" });
    expect((results[0] as { message: string }).message).toContain("Only delete build/tmp.");
    expect((results[0] as { interrupt?: boolean }).interrupt).toBeUndefined();
  });

  it("queues a message sent while the process is closing and resumes with it once it has closed", async () => {
    let release: () => void = () => undefined;
    const closing = new Promise<void>((resolve) => (release = resolve));
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        yield msg.result("first done");
        await ctx.nextUserText(); // input closes (warm idle 0)
        await closing;
      },
      async function* (ctx) {
        expect(await ctx.nextUserText()).toBe("one more thing");
        yield msg.result("second done");
        await ctx.nextUserText();
      },
    ], { settings: { warmIdleMinutes: 0 } });
    const session = await h.manager.start({ cwd: h.workDir, prompt: "go" }, ACTOR);
    await waitFor(() => h.manager.get(session.id).status === "done");

    const queued = await h.manager.message(session.id, "one more thing", ACTOR);
    expect(queued.queuedMessages).toEqual(["one more thing"]);
    release();
    await waitFor(() => h.fake.calls.length === 2);
    expect(h.fake.calls[1]?.resume).toBe(session.id);
    await waitFor(() => h.manager.get(session.id).status === "done" && h.manager.get(session.id).queuedMessages.length === 0);
  });
});

describe("messages to a running claude -p session (hooks)", () => {
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const envelope = (event: string, cwd: string, payload: Record<string, unknown> = {}) => ({
    event: event as never,
    entrypoint: "sdk-cli",
    hubRun: null,
    payload: { session_id: sessionId, transcript_path: "/tmp/t.jsonl", cwd, hook_event_name: event, ...payload },
  });

  it("queues messages while the external process runs and resumes with all of them in order when it ends", async () => {
    const h = makeHarness([
      async function* (ctx) {
        expect(await ctx.nextUserText()).toBe("first\n\nsecond");
        yield msg.result("done");
        await ctx.nextUserText();
      },
    ], { settings: { warmIdleMinutes: 0 } });
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings());
    await compat.handle(envelope("SessionStart", h.workDir), signal());

    await h.manager.message(sessionId, "first", ACTOR);
    const summary = await h.manager.message(sessionId, "second", ACTOR);
    expect(summary.queuedMessages).toEqual(["first", "second"]);
    expect(h.fake.calls).toHaveLength(0);

    await compat.handle(envelope("SessionEnd", h.workDir, { reason: "other" }), signal());
    await waitFor(() => h.fake.calls.length === 1);
    expect(h.fake.calls[0]?.resume).toBe(sessionId);
    await waitFor(() => h.manager.get(sessionId).status === "done");
    expect(h.manager.get(sessionId).queuedMessages).toEqual([]);
    const userMessages = h.store.timeline(sessionId, 0, 1000).filter((event) => event.kind === "user_message").map((event) => event.text);
    expect(userMessages).toEqual(["first", "second"]);
  });

  it("answers a pending PermissionRequest with the typed message instead of queueing it", async () => {
    const h = makeHarness([]);
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings());
    await compat.handle(envelope("SessionStart", h.workDir), signal());
    const decision = compat.handle(envelope("PermissionRequest", h.workDir, { tool_name: "Bash", tool_input: { command: "touch x" } }), signal());
    await waitFor(() => h.manager.get(sessionId).status === "waiting_permission");

    const summary = await h.manager.message(sessionId, "Use the scratch dir instead.", ACTOR);
    expect(summary.queuedMessages).toEqual([]);
    const result = (await decision) as { hookSpecificOutput: { decision: { behavior: string; message: string } } };
    expect(result.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(result.hookSpecificOutput.decision.message).toContain("Use the scratch dir instead.");
  });

  it("keeps the queue when the queued messages cannot be sent, and clearing it drops them", async () => {
    const h = makeHarness([]);
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings());
    const outside = "/tmp/project-not-allowed";
    await compat.handle(envelope("SessionStart", outside), signal());
    await h.manager.message(sessionId, "later", ACTOR);
    await compat.handle(envelope("SessionEnd", outside, { reason: "other" }), signal());
    await waitFor(() => h.store.timeline(sessionId, 0, 1000).some((event) => event.kind === "notice" && event.text.startsWith("Queued messages could not be sent")));
    expect(h.fake.calls).toHaveLength(0);
    expect(h.manager.get(sessionId).queuedMessages).toEqual(["later"]);

    expect(h.manager.clearQueue(sessionId, ACTOR).queuedMessages).toEqual([]);
  });

  it("drops the queue when the owner stops the session", async () => {
    const h = makeHarness([]);
    const compat = new CompatLayer(h.manager, h.clock, () => h.manager.store.loadSettings());
    await compat.handle(envelope("SessionStart", h.workDir), signal());
    await h.manager.message(sessionId, "later", ACTOR);
    expect((await h.manager.stop(sessionId, ACTOR)).queuedMessages).toEqual([]);
  });
});
