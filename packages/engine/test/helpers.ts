/** Test doubles at the I/O boundary: a scripted Claude process, a manual clock and an in-memory store. */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HookCallback, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_SETTINGS, type AuthState, type EngineSettings, type SessionSummary, type WebhookEvent } from "@hub/protocol";
import type { Clock } from "../src/clock.ts";
import { Store } from "../src/db.ts";
import { EventBus } from "../src/events.ts";
import { SessionManager, type ClaudeHost, type QueryFn } from "../src/sessions/manager.ts";

export class ManualClock implements Clock {
  private current = 1_800_000_000_000;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  now(): number {
    return this.current;
  }
  setTimeout(fn: () => void, ms: number) {
    const timer = { at: this.current + ms, fn, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => void (timer.cancelled = true) };
  }
  advance(ms: number): void {
    this.current += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.current);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.fn();
  }
}

export interface ScriptContext {
  options: Options;
  /** The next user message text sent into the process, or null when the input stream closed. */
  nextUserText(): Promise<string | null>;
  askHook(): HookCallback;
}
export type Script = (ctx: ScriptContext) => AsyncGenerator<SDKMessage, void>;

export function fakeQuery(scripts: Script[]): { queryFn: QueryFn; calls: Options[]; interrupts: number[] } {
  const calls: Options[] = [];
  const interrupts: number[] = [];
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const index = calls.length;
    calls.push(params.options);
    const script = scripts[index];
    if (!script) throw new Error(`no script for query call #${index}`);
    const iterator = params.prompt[Symbol.asyncIterator]();
    const ctx: ScriptContext = {
      options: params.options,
      async nextUserText() {
        const next = await iterator.next();
        if (next.done) return null;
        const content = next.value.message.content;
        return typeof content === "string" ? content : JSON.stringify(content);
      },
      askHook() {
        const hook = params.options.hooks?.PreToolUse?.[0]?.hooks[0];
        if (!hook) throw new Error("no AskUserQuestion hook registered");
        return hook;
      },
    };
    const generator = script(ctx);
    return Object.assign(generator, {
      interrupt: async () => {
        interrupts.push(index);
        return undefined;
      },
    }) as unknown as Query;
  }) as unknown as QueryFn;
  return { queryFn, calls, interrupts };
}

export const msg = {
  init: (apiKeySource = "none") => ({ type: "system", subtype: "init", model: "claude-test", permissionMode: "default", apiKeySource, session_id: "s" }) as unknown as SDKMessage,
  text: (text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] }, session_id: "s" }) as unknown as SDKMessage,
  result: (text: string, extra: Record<string, unknown> = {}) =>
    ({ type: "result", subtype: "success", is_error: false, result: text, stop_reason: "end_turn", total_cost_usd: 0.01, num_turns: 1, modelUsage: {}, session_id: "s", ...extra }) as unknown as SDKMessage,
  rateLimit: (status: string, extra: Record<string, unknown> = {}) =>
    ({ type: "rate_limit_event", rate_limit_info: { status, resetsAt: 1_800_000_900, rateLimitType: "five_hour", ...extra }, session_id: "s" }) as unknown as SDKMessage,
};

export const ASK_INPUT = {
  questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "red" }, { label: "blue" }], multiSelect: false }],
};

export function hookInput(toolUseId: string, toolInput: Record<string, unknown> = ASK_INPUT) {
  return { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: toolInput, tool_use_id: toolUseId, session_id: "s", transcript_path: "", cwd: "" } as never;
}

export const SUBSCRIPTION: AuthState = { profileId: "default", method: "subscription", detail: "Subscription", checkedAt: 0 };

export function makeHarness(scripts: Script[], options: { auth?: AuthState; settings?: Partial<EngineSettings> } = {}) {
  const workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-test-")));
  const clock = new ManualClock();
  const store = new Store(":memory:");
  const bus = new EventBus();
  const fake = fakeQuery(scripts);
  const lifecycle: { event: WebhookEvent; session: SessionSummary }[] = [];
  let settings: EngineSettings = { ...DEFAULT_SETTINGS, allowedDirectories: [workDir], ...options.settings };
  const claude: ClaudeHost = {
    executable: async () => "/usr/local/bin/claude",
    auth: async () => options.auth ?? SUBSCRIPTION,
    childEnv: () => ({ PATH: "/usr/bin" }),
    allowsStart: (auth) => auth.method === "subscription" || (settings.allowNonSubscriptionAuth && auth.method === "api_key"),
    isNonSubscriptionKeySource: (source) => source !== "none" && source !== "oauth",
  };
  const manager = new SessionManager({
    store,
    bus,
    clock,
    queryFn: fake.queryFn,
    claude,
    lifecycle: { lifecycle: (event, session) => void lifecycle.push({ event, session }) },
    settings: () => settings,
  });
  return {
    workDir,
    clock,
    store,
    bus,
    manager,
    fake,
    lifecycle,
    setSettings: (next: Partial<EngineSettings>) => void (settings = { ...settings, ...next }),
  };
}

/** Lets queued microtasks and the session's for-await loop make progress. */
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

export async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not met");
}

export const ACTOR = { id: "local" };
