import type { CanUseTool, HookJSONOutput, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ACTOR, ASK_INPUT, flush, hookInput, makeHarness, msg, waitFor, type Script } from "./helpers.ts";

const MINUTE = 60_000;
const signal = () => new AbortController().signal;

async function canUseToolCall(canUseTool: CanUseTool | undefined, toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<PermissionResult> {
  if (!canUseTool) throw new Error("canUseTool missing");
  const result = await canUseTool(toolName, input, { signal: signal(), toolUseID: `tu-${toolName}`, requestId: "r", ...extra } as never);
  if (!result) throw new Error("canUseTool returned no decision");
  return result;
}

/** Script: read the prompt, ask one question through the hook, finish, then idle until input closes. */
function askingScript(captured: HookJSONOutput[], toolUseId = "tu-ask"): Script {
  return async function* (ctx) {
    await ctx.nextUserText();
    yield msg.init();
    captured.push(await ctx.askHook()(hookInput(toolUseId), toolUseId, { signal: signal() }));
    yield msg.result("done");
    await ctx.nextUserText();
  };
}

describe("SessionManager — questions", () => {
  it("surfaces an AskUserQuestion as an open question and resumes the run with the answer", async () => {
    const captured: HookJSONOutput[] = [];
    const h = makeHarness([askingScript(captured)]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "ask me" }, ACTOR);

    await waitFor(() => h.manager.requests(session.id).some((r) => r.state === "open"));
    expect(h.manager.get(session.id).status).toBe("waiting_input");
    const [request] = h.manager.requests(session.id);
    expect(request?.questions?.[0]?.question).toBe("Which colour?");
    expect(h.lifecycle.map((entry) => entry.event)).toContain("session.waiting");

    await h.manager.answer(session.id, request!.id, { kind: "question", answers: { "Which colour?": "blue" } }, ACTOR);
    await waitFor(() => captured.length === 1);
    expect(captured[0]).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...ASK_INPUT, answers: { "Which colour?": "blue" } } },
    });
    await waitFor(() => h.manager.get(session.id).status === "done");
    expect(h.store.auditList(10).some((entry) => entry.action === "request.answer" && entry.actor === "local")).toBe(true);
  });

  it("rejects a second answer to the same request with CONFLICT", async () => {
    const h = makeHarness([askingScript([])]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "ask" }, ACTOR);
    await waitFor(() => h.manager.requests(session.id).length === 1);
    const [request] = h.manager.requests(session.id);
    const answer = { kind: "question" as const, answers: { "Which colour?": "red" } };
    await h.manager.answer(session.id, request!.id, answer, ACTOR);
    await expect(h.manager.answer(session.id, request!.id, answer, { id: "peer:office" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an answer that skips a question or multi-selects a single-select question", async () => {
    const h = makeHarness([askingScript([])]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "ask" }, ACTOR);
    await waitFor(() => h.manager.requests(session.id).length === 1);
    const [request] = h.manager.requests(session.id);
    await expect(h.manager.answer(session.id, request!.id, { kind: "question", answers: {} }, ACTOR)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(h.manager.answer(session.id, request!.id, { kind: "question", answers: { "Which colour?": ["red", "blue"] } }, ACTOR)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("denies automatically after the deny_after window and records the request as expired", async () => {
    const captured: HookJSONOutput[] = [];
    const h = makeHarness([askingScript(captured)], { settings: { defaultWaitPolicy: { mode: "deny_after", minutes: 5 } } });
    const session = await h.manager.start({ cwd: h.workDir, prompt: "ask" }, ACTOR);
    await waitFor(() => h.manager.requests(session.id).length === 1);
    h.clock.advance(5 * MINUTE);
    await waitFor(() => captured.length === 1);
    expect(captured[0]).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(h.manager.requests(session.id)[0]?.state).toBe("expired");
  });
});

describe("SessionManager — defer and resume", () => {
  it("defers after the wait window, closes the process, and resumes the same session when answered", async () => {
    const first: HookJSONOutput[] = [];
    const second: HookJSONOutput[] = [];
    let firstInputClosed = false;
    const h = makeHarness(
      [
        async function* (ctx) {
          await ctx.nextUserText();
          yield msg.init();
          first.push(await ctx.askHook()(hookInput("tu-defer"), "tu-defer", { signal: signal() }));
          yield msg.result("", { stop_reason: "tool_deferred", deferred_tool_use: { id: "tu-defer", name: "AskUserQuestion", input: ASK_INPUT } });
          firstInputClosed = (await ctx.nextUserText()) === null;
        },
        async function* (ctx) {
          yield msg.init();
          second.push(await ctx.askHook()(hookInput("tu-defer"), "tu-defer", { signal: signal() }));
          yield msg.result("blue");
          await ctx.nextUserText();
        },
      ],
      { settings: { defaultWaitPolicy: { mode: "defer_after", minutes: 30 } } },
    );
    const session = await h.manager.start({ cwd: h.workDir, prompt: "ask" }, ACTOR);
    await waitFor(() => h.manager.requests(session.id).length === 1);

    h.clock.advance(30 * MINUTE);
    await waitFor(() => h.manager.get(session.id).status === "deferred" && !h.manager.get(session.id).live);
    expect(first[0]).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } });
    expect(firstInputClosed).toBe(true);
    expect(h.lifecycle.map((entry) => entry.event)).toContain("session.deferred");
    const [request] = h.manager.requests(session.id);
    expect(request?.state).toBe("deferred");

    await h.manager.answer(session.id, request!.id, { kind: "question", answers: { "Which colour?": "blue" } }, ACTOR);
    await waitFor(() => second.length === 1);
    expect(h.fake.calls[1]?.resume).toBe(session.id);
    expect(h.fake.calls[1]?.sessionId).toBeUndefined();
    expect(h.fake.calls[1]?.permissionMode).toBe("auto"); // the stored launch mode (default: auto) is passed again on resume
    expect(second[0]).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { answers: { "Which colour?": "blue" } } } });
    await waitFor(() => h.manager.get(session.id).status === "done");
  });

  it("resumes a deferred permission with a one-shot pre-approval for exactly that call", async () => {
    const results: PermissionResult[] = [];
    const input = { command: "npm publish" };
    const h = makeHarness(
      [
        async function* (ctx) {
          await ctx.nextUserText();
          yield msg.init();
          results.push(await canUseToolCall(ctx.options.canUseTool, "Bash", input));
          yield msg.result("paused");
          await ctx.nextUserText();
        },
        async function* (ctx) {
          const text = await ctx.nextUserText();
          expect(text).toContain("approved your pending Bash request");
          results.push(await canUseToolCall(ctx.options.canUseTool, "Bash", input));
          results.push(await canUseToolCall(ctx.options.canUseTool, "Bash", { command: "npm publish --force" }, { signal: AbortSignal.abort() }));
          yield msg.result("published");
          await ctx.nextUserText();
        },
      ],
      { settings: { defaultWaitPolicy: { mode: "defer_after", minutes: 30 } } },
    );
    const session = await h.manager.start({ cwd: h.workDir, prompt: "publish" }, ACTOR);
    await waitFor(() => h.manager.requests(session.id).length === 1);
    h.clock.advance(30 * MINUTE);
    await waitFor(() => h.manager.get(session.id).status === "deferred");
    expect(results[0]).toMatchObject({ behavior: "deny", interrupt: true });

    const [request] = h.manager.requests(session.id);
    await h.manager.answer(session.id, request!.id, { kind: "permission", decision: "allow" }, ACTOR);
    await waitFor(() => results.length === 3);
    expect(results[1]).toEqual({ behavior: "allow", updatedInput: input });
    // A different call is not covered by the pre-approval and goes to the human (here: aborted).
    expect(results[2]).toMatchObject({ behavior: "deny" });
  });
});

describe("SessionManager — permissions", () => {
  const suggestions = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch x" }], behavior: "allow", destination: "localSettings" },
    { type: "addDirectories", directories: ["/tmp"], destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ];

  async function permissionRun(decision: "allow" | "allow_session" | "deny", message?: string) {
    const results: PermissionResult[] = [];
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        results.push(await canUseToolCall(ctx.options.canUseTool, "Bash", { command: "touch x" }, { suggestions }));
        yield msg.result("ok");
        await ctx.nextUserText();
      },
    ]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "touch" }, ACTOR);
    await waitFor(() => h.manager.requests(session.id).length === 1);
    expect(h.manager.get(session.id).status).toBe("waiting_permission");
    const [request] = h.manager.requests(session.id);
    expect(request?.inputPreview).toBe("touch x");
    await h.manager.answer(session.id, request!.id, { kind: "permission", decision, ...(message ? { message } : {}) }, ACTOR);
    await waitFor(() => results.length === 1);
    return results[0];
  }

  it("passes the owner's denial message back to the model", async () => {
    expect(await permissionRun("deny", "not on main")).toEqual({ behavior: "deny", message: "not on main" });
  });

  it("allows once without touching permission rules", async () => {
    expect(await permissionRun("allow")).toEqual({ behavior: "allow", updatedInput: { command: "touch x" } });
  });

  it("allow_session only adds session-scoped allow rules (never localSettings, never a mode change)", async () => {
    expect(await permissionRun("allow_session")).toEqual({
      behavior: "allow",
      updatedInput: { command: "touch x" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch x" }], behavior: "allow", destination: "session" }],
    });
  });
});

describe("SessionManager — limits, auth and boundaries", () => {
  it("moves to usage_limit on a rejected rate-limit event, stops the run and notifies", async () => {
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        yield msg.init();
        yield msg.rateLimit("rejected");
        yield msg.result("", { subtype: "error_during_execution", is_error: true, errors: ["usage limit"] });
        await ctx.nextUserText();
      },
    ]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "go" }, ACTOR);
    await waitFor(() => !h.manager.get(session.id).live && h.manager.get(session.id).status === "usage_limit");
    const after = h.manager.get(session.id);
    expect(after.usageLimit).toMatchObject({ kind: "rejected", limitType: "five_hour" });
    expect(h.fake.interrupts).toEqual([0]);
    expect(h.lifecycle.map((entry) => entry.event)).toContain("session.usage_limit");
  });

  it("pauses when the subscription starts spending usage credits (overage)", async () => {
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        yield msg.rateLimit("allowed", { isUsingOverage: true });
        await ctx.nextUserText();
      },
    ]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "go" }, ACTOR);
    await waitFor(() => h.manager.get(session.id).status === "usage_limit");
    expect(h.manager.get(session.id).usageLimit?.kind).toBe("overage");
  });

  it("refuses to start under an API-key login and never launches the CLI", async () => {
    const h = makeHarness([], { auth: { profileId: "default", method: "api_key", detail: "API key (api_key)", checkedAt: 0 } });
    await expect(h.manager.start({ cwd: h.workDir, prompt: "go" }, ACTOR)).rejects.toMatchObject({ code: "AUTH_BLOCKED" });
    expect(h.fake.calls).toHaveLength(0);
    expect(h.store.auditList(5)[0]?.action).toBe("session.auth_blocked");
  });

  it("aborts a session whose init reports an API key source", async () => {
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        yield msg.init("ANTHROPIC_API_KEY");
        await ctx.nextUserText();
      },
    ]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "go" }, ACTOR);
    await waitFor(() => h.manager.get(session.id).endReason === "auth_blocked");
    expect(h.fake.calls[0]?.abortController?.signal.aborted).toBe(true);
  });

  it("refuses a working directory outside the allowlist, including a sibling with the same prefix", async () => {
    const h = makeHarness([]);
    await expect(h.manager.start({ cwd: "/", prompt: "go" }, ACTOR)).rejects.toMatchObject({ code: "DIRECTORY_NOT_ALLOWED" });
    const { mkdirSync } = await import("node:fs");
    const sibling = `${h.workDir}-evil`;
    mkdirSync(sibling, { recursive: true });
    await expect(h.manager.start({ cwd: sibling, prompt: "go" }, ACTOR)).rejects.toMatchObject({ code: "DIRECTORY_NOT_ALLOWED" });
  });

  it("stops a waiting session: the request is cancelled and the status is done/stopped_by_user", async () => {
    const captured: HookJSONOutput[] = [];
    const h = makeHarness([askingScript(captured)]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "ask" }, ACTOR);
    await waitFor(() => h.manager.requests(session.id).length === 1);
    await h.manager.stop(session.id, ACTOR);
    await waitFor(() => captured.length === 1 && !h.manager.get(session.id).live);
    expect(captured[0]).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(h.manager.get(session.id)).toMatchObject({ status: "done", endReason: "stopped_by_user" });
    expect(h.manager.requests(session.id)[0]?.state).toBe("cancelled");
  });

  it("resumes a finished, closed session when a message is sent", async () => {
    const h = makeHarness(
      [
        async function* (ctx) {
          await ctx.nextUserText();
          yield msg.result("first");
          await ctx.nextUserText();
        },
        async function* (ctx) {
          expect(await ctx.nextUserText()).toBe("and now?");
          yield msg.result("second");
          await ctx.nextUserText();
        },
      ],
      { settings: { warmIdleMinutes: 0 } },
    );
    const session = await h.manager.start({ cwd: h.workDir, prompt: "hi" }, ACTOR);
    await waitFor(() => h.manager.get(session.id).status === "done" && !h.manager.get(session.id).live);
    await h.manager.message(session.id, "and now?", ACTOR);
    await waitFor(() => h.fake.calls.length === 2);
    expect(h.fake.calls[1]?.resume).toBe(session.id);
    await flush();
    await waitFor(() => h.manager.get(session.id).status === "done");
  });
});
