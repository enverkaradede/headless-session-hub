/** Owns every session on this device: launching, streaming, questions/permissions, stop/resume, recovery. */
import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  Options,
  PermissionResult,
  PermissionUpdate,
  PreToolUseHookInput,
  Query,
  SDKMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AuthState,
  type ClaudeProfile,
  type EngineSettings,
  type PendingRequest,
  type Question,
  type RequestAnswer,
  type SessionStatus,
  type SessionSummary,
  type StartSessionParams,
  type TimelineEvent,
  type WaitPolicy,
  StartSessionParams as StartSessionSchema,
} from "@hub/protocol";
import type { Clock } from "../clock.ts";
import type { LaunchConfig, SessionRow, Store, StoredRequest } from "../db.ts";
import { EngineError } from "../errors.ts";
import type { EventBus, LifecycleSink } from "../events.ts";
import { log } from "../log.ts";
import { assertAllowedDirectory } from "../paths.ts";
import { parseQuestions, permissionResult, previewToolInput, validateQuestionAnswer } from "../permissions.ts";
import { InputQueue } from "./input-queue.ts";
import { translate, truncateText, type ResultInfo, type Translation } from "./translate.ts";

const MINUTE_MS = 60_000;
/** Upper bound for one wait inside a hook; matches the longest configurable wait policy (7 days). */
const HOOK_WAIT_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
const INTERRUPT_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 10_000;
const DEFAULT_NAME_CHARS = 60;
const LIVE_STATUSES: readonly SessionStatus[] = ["starting", "running", "waiting_input", "waiting_permission", "idle"];

export type QueryFn = typeof sdkQuery;

/** The parts of the Claude CLI the manager needs; faked in tests. */
export interface ClaudeHost {
  executable(): Promise<string | null>;
  auth(profile: ClaudeProfile): Promise<AuthState>;
  childEnv(profile: ClaudeProfile, extra: Record<string, string> | undefined): NodeJS.ProcessEnv;
  allowsStart(auth: AuthState): boolean;
  isNonSubscriptionKeySource(apiKeySource: string): boolean;
}

export interface ManagerDeps {
  store: Store;
  bus: EventBus;
  clock: Clock;
  queryFn: QueryFn;
  claude: ClaudeHost;
  lifecycle: LifecycleSink;
  settings: () => EngineSettings;
}

type Outcome =
  | { type: "answered"; answer: RequestAnswer }
  | { type: "expired" }
  | { type: "defer" }
  | { type: "cancelled" };

interface Waiter {
  resolve: (outcome: Outcome) => void;
}

interface LiveSession {
  input: InputQueue;
  abort: AbortController;
  query: Query | null;
  idleTimer: { cancel(): void } | null;
  /** The owner asked to stop; the process end is expected. */
  stopping: boolean;
  /** A request was deferred; the process end leaves the session in `deferred`. */
  deferring: boolean;
  /** Usage limit or overage stopped the run. */
  limitStopped: boolean;
  /** Exact tool calls the owner approved while the session was closed (deferred permissions). */
  preApproved: Set<string>;
}

export interface Actor {
  id: string;
}

function approvalKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}\u0000${JSON.stringify(input)}`;
}

function defaultName(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? "";
  return firstLine.length > DEFAULT_NAME_CHARS ? `${firstLine.slice(0, DEFAULT_NAME_CHARS - 1)}…` : firstLine || "Untitled session";
}

export class SessionManager {
  private readonly live = new Map<string, LiveSession>();
  private readonly waiters = new Map<string, Waiter>();

  constructor(private readonly deps: ManagerDeps) {}

  // ── queries ────────────────────────────────────────────────────────────────

  summary(row: SessionRow, openCounts?: Map<string, number>): SessionSummary {
    const { launch: _launch, ...rest } = row;
    const openRequests = openCounts?.get(row.id) ?? this.deps.store.requestsForSession(row.id).filter((r) => r.state === "open").length;
    return { ...rest, openRequests, live: this.live.has(row.id) };
  }

  list(filter: { status?: SessionStatus[] | undefined; label?: string | undefined; limit: number }): SessionSummary[] {
    const counts = this.deps.store.openRequestCounts();
    return this.deps.store
      .listSessions(filter.limit)
      .filter((row) => !filter.status || filter.status.includes(row.status))
      .filter((row) => !filter.label || row.labels.includes(filter.label))
      .map((row) => this.summary(row, counts));
  }

  get(sessionId: string): SessionSummary {
    return this.summary(this.requireRow(sessionId));
  }

  timeline(sessionId: string, afterSeq: number, limit: number): TimelineEvent[] {
    this.requireRow(sessionId);
    return this.deps.store.timeline(sessionId, afterSeq, limit);
  }

  requests(sessionId: string): PendingRequest[] {
    this.requireRow(sessionId);
    return this.deps.store.requestsForSession(sessionId).map((request) => this.publicRequest(request));
  }

  // ── commands ───────────────────────────────────────────────────────────────

  async start(rawParams: StartSessionParams, actor: Actor): Promise<SessionSummary> {
    const params = StartSessionSchema.parse(rawParams);
    const settings = this.deps.settings();
    const profile = this.profile(params.profileId ?? settings.defaultProfileId);
    const cwd = await assertAllowedDirectory(params.cwd, settings.allowedDirectories);
    const now = this.deps.clock.now();
    const launch: LaunchConfig = {
      permissionMode: params.permissionMode,
      ...(params.model ? { model: params.model } : {}),
      ...(params.appendSystemPrompt ? { appendSystemPrompt: params.appendSystemPrompt } : {}),
      ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
      ...(params.disallowedTools ? { disallowedTools: params.disallowedTools } : {}),
      ...(params.env ? { env: params.env } : {}),
      ...(params.maxTurns ? { maxTurns: params.maxTurns } : {}),
      ...(params.maxBudgetUsd ? { maxBudgetUsd: params.maxBudgetUsd } : {}),
      ...(params.waitPolicy ? { waitPolicy: params.waitPolicy } : {}),
    };
    const row: SessionRow = {
      id: randomUUID(),
      name: params.name?.trim() || defaultName(params.prompt),
      labels: params.labels,
      cwd,
      profileId: profile.id,
      model: params.model ?? null,
      permissionMode: params.permissionMode,
      origin: "app",
      status: "starting",
      endReason: null,
      errorMessage: null,
      usageLimit: null,
      createdAt: now,
      lastActivityAt: now,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastMessagePreview: null,
      launch,
    };
    await this.preflight(profile, actor, row.id);
    this.deps.store.insertSession(row);
    this.audit(actor, "session.start", row.id, null, `cwd=${cwd} profile=${profile.id}`);
    this.appendTimeline(row.id, "user_message", params.prompt);
    this.launch(row, profile, { kind: "new", prompt: params.prompt });
    const summary = this.get(row.id);
    this.deps.lifecycle.lifecycle("session.started", summary, null);
    return summary;
  }

  /** Sends a message: straight into a live process, otherwise by resuming the session. */
  async message(sessionId: string, text: string, actor: Actor): Promise<SessionSummary> {
    const row = this.requireRow(sessionId);
    this.audit(actor, "session.message", sessionId, null, `chars=${text.length}`);
    const live = this.live.get(sessionId);
    if (live && !live.input.isClosed && !live.stopping) {
      live.idleTimer?.cancel();
      live.idleTimer = null;
      this.appendTimeline(sessionId, "user_message", text);
      live.input.pushText(text);
      this.patch(sessionId, { status: "running", endReason: null, errorMessage: null });
      return this.get(sessionId);
    }
    if (live) throw new EngineError("CONFLICT", "The session is shutting down; try again in a moment.");
    if (row.origin === "hook" && !["done", "error", "usage_limit"].includes(row.status)) {
      throw new EngineError("CONFLICT", "This session is still running in an external claude -p process.");
    }
    // A new prompt supersedes anything deferred: Claude answers the prompt and skips the parked call.
    for (const request of this.deps.store.requestsForSession(sessionId)) {
      if (request.state === "deferred" || request.state === "open") this.cancelRequest(request, actor.id);
    }
    const profile = this.profile(row.profileId);
    await this.preflight(profile, actor, sessionId);
    this.appendTimeline(sessionId, "user_message", text);
    this.patch(sessionId, { status: "starting", endReason: null, errorMessage: null, usageLimit: null });
    this.launch(row, profile, { kind: "resume", prompt: text });
    return this.get(sessionId);
  }

  async stop(sessionId: string, actor: Actor): Promise<SessionSummary> {
    this.requireRow(sessionId);
    this.audit(actor, "session.stop", sessionId, null, "");
    for (const request of this.deps.store.requestsForSession(sessionId)) {
      if (request.state === "open" || request.state === "deferred") this.cancelRequest(request, actor.id);
    }
    const live = this.live.get(sessionId);
    this.patch(sessionId, { status: "done", endReason: "stopped_by_user" });
    if (live) {
      live.stopping = true;
      live.idleTimer?.cancel();
      const interrupted = live.query
        ? Promise.race([live.query.interrupt().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, INTERRUPT_TIMEOUT_MS))])
        : Promise.resolve();
      await interrupted;
      live.input.close();
      this.deps.clock.setTimeout(() => {
        if (this.live.get(sessionId) === live) live.abort.abort();
      }, STOP_GRACE_MS);
    }
    return this.get(sessionId);
  }

  update(sessionId: string, patch: { name?: string | undefined; labels?: string[] | undefined }, actor: Actor): SessionSummary {
    this.requireRow(sessionId);
    const next: Partial<SessionRow> = {};
    if (patch.name !== undefined) next.name = patch.name || "Untitled session";
    if (patch.labels !== undefined) next.labels = patch.labels;
    this.deps.store.updateSession(sessionId, next);
    this.audit(actor, "session.update", sessionId, null, JSON.stringify(Object.keys(next)));
    this.emitSession(sessionId);
    return this.get(sessionId);
  }

  async answer(sessionId: string, requestId: string, answer: RequestAnswer, actor: Actor): Promise<PendingRequest> {
    const request = this.deps.store.getRequest(requestId);
    if (!request || request.sessionId !== sessionId) throw new EngineError("NOT_FOUND", "Request not found");
    if (request.kind !== answer.kind) throw new EngineError("BAD_REQUEST", `This request expects a ${request.kind} answer`);
    if (answer.kind === "question") {
      const problem = validateQuestionAnswer(request.questions ?? [], answer.answers);
      if (problem) throw new EngineError("BAD_REQUEST", problem);
    }
    if (request.state !== "open" && request.state !== "deferred") throw new EngineError("CONFLICT", `Request is already ${request.state}`);
    const wasDeferred = request.state === "deferred";
    if (!this.closeRequest(request, "answered", answer, actor.id)) throw new EngineError("CONFLICT", "Request was answered by someone else");
    const detail = answer.kind === "permission" ? `decision=${answer.decision}` : `questions=${Object.keys(answer.answers).length}`;
    this.audit(actor, "request.answer", sessionId, requestId, detail);
    const waiter = this.waiters.get(requestId);
    if (waiter) {
      waiter.resolve({ type: "answered", answer });
    } else if (wasDeferred) {
      await this.resumeDeferred(sessionId, request, answer, actor);
    }
    const updated = this.deps.store.getRequest(requestId);
    if (!updated) throw new EngineError("INTERNAL", "Request vanished after answering");
    return this.publicRequest(updated);
  }

  /** Marks sessions orphaned by an engine restart; deferred sessions stay resumable. */
  recover(): void {
    for (const row of this.deps.store.sessionsWithStatus(LIVE_STATUSES)) {
      if (row.origin === "hook") continue; // hook sessions belong to external processes and report their own end
      this.deps.store.updateSession(row.id, { status: "error", endReason: "engine_restart", errorMessage: "Session Hub restarted while this session was running." });
    }
    for (const request of this.deps.store.requestsInState("open")) {
      const row = this.deps.store.getRequest(request.id);
      if (row) this.deps.store.closeRequest(row.id, "cancelled", null, "engine", this.deps.clock.now());
    }
  }

  /** Called by the compat layer for sessions owned by external `claude -p` processes. */
  get store(): Store {
    return this.deps.store;
  }

  // ── compat (sessions owned by external claude -p processes) ──────────────

  compatRegister(row: SessionRow): void {
    this.deps.store.insertSession(row);
    this.audit({ id: "hook" }, "session.observe", row.id, null, `cwd=${row.cwd}`);
    this.emitSession(row.id);
    this.deps.lifecycle.lifecycle("session.started", this.get(row.id), null);
  }

  compatStatus(sessionId: string, status: SessionStatus, endReason: SessionRow["endReason"]): void {
    this.patch(sessionId, { status, endReason });
  }

  compatEnd(sessionId: string, reason: string): void {
    for (const request of this.deps.store.requestsForSession(sessionId)) {
      if (request.state === "open") this.cancelRequest(request, "hook");
    }
    const row = this.deps.store.getSession(sessionId);
    if (!row || row.status === "error" || row.status === "usage_limit") return;
    this.patch(sessionId, { status: "done", endReason: "completed" });
    this.appendTimeline(sessionId, "notice", `Session ended (${reason}).`);
    this.deps.lifecycle.lifecycle("session.completed", this.get(sessionId), row.lastMessagePreview);
  }

  /** Waits for the owner to answer a PermissionRequest hook; null when the hook budget runs out. */
  async compatAwaitPermission(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    suggestions: PermissionUpdate[] | null,
    signal: AbortSignal,
  ): Promise<RequestAnswer | null> {
    const request = this.openRequest(sessionId, toolName, null, input, suggestions, null, { mode: "wait" });
    const outcome = await this.awaitOutcome(request, signal);
    return outcome.type === "answered" ? outcome.answer : null;
  }

  // ── launching ──────────────────────────────────────────────────────────────

  private async preflight(profile: ClaudeProfile, actor: Actor, sessionId: string): Promise<void> {
    const executable = await this.deps.claude.executable();
    if (!executable) throw new EngineError("CLAUDE_NOT_FOUND", "Claude Code was not found. Install it or set its path in Settings.");
    const auth = await this.deps.claude.auth(profile);
    if (!this.deps.claude.allowsStart(auth)) {
      this.audit(actor, "session.auth_blocked", sessionId, null, `profile=${profile.id} method=${auth.method}`);
      throw new EngineError("AUTH_BLOCKED", `${auth.detail}. Sessions only start on a subscription login unless you allow other methods in Settings.`);
    }
  }

  private launch(row: SessionRow, profile: ClaudeProfile, mode: { kind: "new" | "resume"; prompt: string | null }): void {
    const live: LiveSession = {
      input: new InputQueue(),
      abort: new AbortController(),
      query: null,
      idleTimer: null,
      stopping: false,
      deferring: false,
      limitStopped: false,
      preApproved: new Set(),
    };
    this.live.set(row.id, live);
    if (mode.prompt !== null) live.input.pushText(mode.prompt);
    void this.run(row, profile, live, mode.kind);
  }

  private async run(row: SessionRow, profile: ClaudeProfile, live: LiveSession, kind: "new" | "resume"): Promise<void> {
    let failure: unknown = null;
    try {
      const executable = await this.deps.claude.executable();
      if (!executable) throw new EngineError("CLAUDE_NOT_FOUND", "Claude Code executable disappeared");
      const options = this.buildOptions(row, profile, live, executable, kind);
      const query = this.deps.queryFn({ prompt: live.input, options });
      live.query = query;
      this.patch(row.id, { status: "running" });
      for await (const message of query) this.handleMessage(row.id, live, message);
    } catch (err) {
      failure = err;
    } finally {
      this.onProcessEnd(row.id, live, failure);
    }
  }

  private buildOptions(row: SessionRow, profile: ClaudeProfile, live: LiveSession, executable: string, kind: "new" | "resume"): Options {
    const launch = row.launch;
    const askHook: HookCallback = (input, _toolUseId, { signal }) => this.onAskUserQuestionHook(row.id, live, input as PreToolUseHookInput, signal);
    const options: Options = {
      cwd: row.cwd,
      pathToClaudeCodeExecutable: executable,
      env: this.deps.claude.childEnv(profile, launch.env),
      abortController: live.abort,
      // Resuming with -p does not restore the stored mode, so it is passed on every launch.
      permissionMode: launch.permissionMode as NonNullable<Options["permissionMode"]>,
      settingSources: ["user", "project", "local"],
      systemPrompt: launch.appendSystemPrompt
        ? { type: "preset", preset: "claude_code", append: launch.appendSystemPrompt }
        : { type: "preset", preset: "claude_code" },
      canUseTool: this.canUseTool(row.id, live),
      hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [askHook], timeout: HOOK_WAIT_TIMEOUT_SECONDS, onFailure: "block" }] },
      stderr: (data) => log.debug("claude stderr", { sessionId: row.id, data: truncateText(data, 2000) }),
    };
    if (kind === "new") options.sessionId = row.id;
    else options.resume = row.id;
    if (launch.model) options.model = launch.model;
    if (launch.allowedTools) options.allowedTools = launch.allowedTools;
    if (launch.disallowedTools) options.disallowedTools = launch.disallowedTools;
    if (launch.maxTurns) options.maxTurns = launch.maxTurns;
    if (launch.maxBudgetUsd) options.maxBudgetUsd = launch.maxBudgetUsd;
    return options;
  }

  private async resumeDeferred(sessionId: string, request: StoredRequest, answer: RequestAnswer, actor: Actor): Promise<void> {
    const row = this.requireRow(sessionId);
    const profile = this.profile(row.profileId);
    await this.preflight(profile, actor, sessionId);
    this.patch(sessionId, { status: "starting", endReason: null, errorMessage: null });
    if (request.kind === "question") {
      // No prompt: the parked AskUserQuestion fires PreToolUse again and picks up the stored answer.
      this.launch(row, profile, { kind: "resume", prompt: null });
      return;
    }
    const decision = answer.kind === "permission" ? answer.decision : "deny";
    const text =
      decision === "deny"
        ? `[Session Hub] The owner denied your pending ${request.toolName} request${answer.kind === "permission" && answer.message ? `: ${answer.message}` : ""}. Continue without it.`
        : `[Session Hub] The owner approved your pending ${request.toolName} request. Retry it now.`;
    this.appendTimeline(sessionId, "notice", text);
    this.launch(row, profile, { kind: "resume", prompt: text });
    const live = this.live.get(sessionId);
    if (live && decision !== "deny") live.preApproved.add(approvalKey(request.toolName, request.input));
  }

  // ── questions & permissions ────────────────────────────────────────────────

  private async onAskUserQuestionHook(sessionId: string, live: LiveSession, input: PreToolUseHookInput, signal: AbortSignal): Promise<HookJSONOutput> {
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const existing = this.deps.store.requestByToolUseId(sessionId, input.tool_use_id);
    if (existing?.state === "answered" && existing.answer?.kind === "question") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...toolInput, answers: existing.answer.answers } } };
    }
    const request = existing && existing.state === "deferred" ? this.reopen(existing) : this.openRequest(sessionId, "AskUserQuestion", input.tool_use_id, toolInput, null, null);
    const outcome = await this.awaitOutcome(request, signal);
    switch (outcome.type) {
      case "answered": {
        const answers = outcome.answer.kind === "question" ? outcome.answer.answers : {};
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...toolInput, answers } } };
      }
      case "defer":
        live.deferring = true;
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } };
      case "expired":
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: this.expiredMessage(request.policy) } };
      case "cancelled":
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The question was cancelled." } };
    }
  }

  private canUseTool(sessionId: string, live: LiveSession): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      const key = approvalKey(toolName, input);
      if (live.preApproved.delete(key)) {
        this.audit({ id: "engine" }, "request.preapproved_used", sessionId, null, `tool=${toolName}`);
        return { behavior: "allow", updatedInput: input };
      }
      if (toolName === "AskUserQuestion") return this.askViaCanUseTool(sessionId, input, options.toolUseID, options.signal);
      const request = this.openRequest(sessionId, toolName, options.toolUseID, input, options.suggestions ?? null, options.blockedPath ?? null);
      const outcome = await this.awaitOutcome(request, options.signal);
      switch (outcome.type) {
        case "answered":
          return outcome.answer.kind === "permission"
            ? permissionResult(outcome.answer, input, request.suggestions)
            : { behavior: "deny", message: "Unexpected answer type" };
        case "expired":
          return { behavior: "deny", message: this.expiredMessage(request.policy) };
        case "defer":
          live.deferring = true;
          return { behavior: "deny", message: "Paused by Session Hub until the owner decides on this request.", interrupt: true };
        case "cancelled":
          return { behavior: "deny", message: "The request was cancelled.", interrupt: true };
      }
    };
  }

  /** Fallback when the CLI ignored a defer (several tool calls in one turn): wait without deferring. */
  private async askViaCanUseTool(sessionId: string, input: Record<string, unknown>, toolUseId: string, signal: AbortSignal): Promise<PermissionResult> {
    const existing = this.deps.store.requestByToolUseId(sessionId, toolUseId);
    if (existing?.state === "answered" && existing.answer?.kind === "question") {
      return { behavior: "allow", updatedInput: { ...input, answers: existing.answer.answers } };
    }
    const request = existing && (existing.state === "open" || existing.state === "deferred")
      ? this.reopen(existing)
      : this.openRequest(sessionId, "AskUserQuestion", toolUseId, input, null, null);
    const outcome = await this.awaitOutcome({ ...request, policy: { mode: "wait" } }, signal);
    if (outcome.type === "answered" && outcome.answer.kind === "question") {
      return { behavior: "allow", updatedInput: { ...input, answers: outcome.answer.answers } };
    }
    return { behavior: "deny", message: "The question was not answered." };
  }

  private openRequest(
    sessionId: string,
    toolName: string,
    toolUseId: string | null,
    input: Record<string, unknown>,
    suggestions: PermissionUpdate[] | null,
    blockedPath: string | null,
    policyOverride?: WaitPolicy,
  ): StoredRequest {
    const row = this.requireRow(sessionId);
    const policy: WaitPolicy = policyOverride ?? row.launch.waitPolicy ?? this.deps.settings().defaultWaitPolicy;
    const now = this.deps.clock.now();
    const isQuestion = toolName === "AskUserQuestion";
    const questions: Question[] | null = isQuestion ? parseQuestions(input) : null;
    const request: StoredRequest = {
      id: randomUUID(),
      sessionId,
      kind: isQuestion ? "question" : "permission",
      toolName,
      toolUseId,
      input,
      questions,
      suggestions,
      blockedPath,
      state: "open",
      createdAt: now,
      expiresAt: policy.mode === "wait" ? null : now + policy.minutes * MINUTE_MS,
      policy,
      answer: null,
      answeredBy: null,
      answeredAt: null,
    };
    this.deps.store.insertRequest(request);
    this.afterRequestChange(request, isQuestion ? "Question" : `Permission: ${toolName}`);
    return request;
  }

  /** A deferred request comes back to life when its tool call fires again after a resume. */
  private reopen(request: StoredRequest): StoredRequest {
    const now = this.deps.clock.now();
    const expiresAt = request.policy.mode === "wait" ? null : now + request.policy.minutes * MINUTE_MS;
    this.deps.store.reopenRequest(request.id, expiresAt);
    const reopened = this.deps.store.getRequest(request.id);
    if (!reopened) throw new EngineError("INTERNAL", "Failed to reopen request");
    this.afterRequestChange(reopened, "Question");
    return reopened;
  }

  private afterRequestChange(request: StoredRequest, title: string): void {
    const label = request.kind === "question" ? (request.questions?.[0]?.question ?? title) : `${request.toolName}: ${previewToolInput(request.toolName, request.input).split("\n")[0] ?? ""}`;
    this.appendTimeline(request.sessionId, "request_opened", label, { toolName: request.toolName, toolUseId: request.toolUseId, data: { requestId: request.id, kind: request.kind } });
    this.deps.bus.emit({ type: "request.upsert", request: this.publicRequest(request) });
    this.refreshWaitingStatus(request.sessionId);
    const session = this.get(request.sessionId);
    this.deps.bus.emit({ type: "notify", title: `${session.name} needs you`, body: truncateText(label, 200), sessionId: request.sessionId });
    this.deps.lifecycle.lifecycle("session.waiting", session, label);
  }

  private awaitOutcome(request: StoredRequest, signal: AbortSignal): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      let timer: { cancel(): void } | null = null;
      const finish = (outcome: Outcome) => {
        if (!this.waiters.has(request.id)) return;
        this.waiters.delete(request.id);
        timer?.cancel();
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => {
        this.closeRequest(request, "cancelled", null, "engine");
        finish({ type: "cancelled" });
      };
      this.waiters.set(request.id, { resolve: finish });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      const policy = request.policy;
      if (policy.mode === "wait") return;
      const remaining = Math.max(0, (request.expiresAt ?? this.deps.clock.now()) - this.deps.clock.now());
      timer = this.deps.clock.setTimeout(() => {
        if (policy.mode === "deny_after") {
          if (this.closeRequest(request, "expired", null, "policy")) finish({ type: "expired" });
        } else if (this.deps.store.markRequestDeferred(request.id)) {
          this.emitRequest(request.id);
          this.appendTimeline(request.sessionId, "notice", `No answer within ${policy.minutes} min. Deferred; the process closes and resumes when you answer.`);
          finish({ type: "defer" });
        }
      }, remaining);
    });
  }

  private closeRequest(request: StoredRequest, state: "answered" | "expired" | "cancelled", answer: RequestAnswer | null, by: string): boolean {
    const changed = this.deps.store.closeRequest(request.id, state, answer, by, this.deps.clock.now());
    if (!changed) return false;
    this.appendTimeline(request.sessionId, "request_closed", state, { toolName: request.toolName, toolUseId: request.toolUseId, data: { requestId: request.id, state } });
    this.emitRequest(request.id);
    this.refreshWaitingStatus(request.sessionId);
    return true;
  }

  /** Cancels a request and wakes whoever is waiting on it (stop, superseding message, process end). */
  private cancelRequest(request: StoredRequest, by: string): void {
    if (this.closeRequest(request, "cancelled", null, by)) this.waiters.get(request.id)?.resolve({ type: "cancelled" });
  }

  private expiredMessage(policy: WaitPolicy): string {
    return policy.mode === "wait" ? "No answer." : `No answer within ${policy.minutes} minutes; the request was denied automatically.`;
  }

  // ── stream handling ────────────────────────────────────────────────────────

  private handleMessage(sessionId: string, live: LiveSession, message: SDKMessage): void {
    const translation = translate(message);
    for (const draft of translation.drafts) this.appendTimeline(sessionId, draft.kind, draft.text, draft);
    const patch: Partial<SessionRow> = {};
    if (translation.preview) patch.lastMessagePreview = translation.preview;
    if (translation.init) this.onInit(sessionId, live, translation.init, patch);
    if (translation.rateLimit) this.onRateLimit(sessionId, live, translation.rateLimit);
    if (Object.keys(patch).length > 0) this.patch(sessionId, patch);
    if (translation.result) this.onResult(sessionId, live, translation.result);
  }

  private onInit(sessionId: string, live: LiveSession, init: NonNullable<Translation["init"]>, patch: Partial<SessionRow>): void {
    patch.model = init.model;
    patch.permissionMode = init.permissionMode;
    if (this.deps.claude.isNonSubscriptionKeySource(init.apiKeySource) && !this.deps.settings().allowNonSubscriptionAuth) {
      // Belt and braces: the env is sanitized, but a settings-level apiKeyHelper could still switch billing.
      live.stopping = true;
      this.audit({ id: "engine" }, "session.auth_blocked", sessionId, null, `apiKeySource=${init.apiKeySource}`);
      this.patch(sessionId, { status: "error", endReason: "auth_blocked", errorMessage: `Stopped: this session would use ${init.apiKeySource} instead of the subscription login.` });
      live.abort.abort();
    }
  }

  private onRateLimit(sessionId: string, live: LiveSession, rateLimit: NonNullable<Translation["rateLimit"]>): void {
    const overageStop = rateLimit.usingOverage && this.deps.settings().pauseOnOverage;
    if (rateLimit.status === "allowed_warning" && !overageStop) {
      this.appendTimeline(sessionId, "notice", "Approaching the usage limit.");
      return;
    }
    if (rateLimit.status !== "rejected" && !overageStop) return;
    live.limitStopped = true;
    const usageLimit = { kind: rateLimit.status === "rejected" ? ("rejected" as const) : ("overage" as const), ...rateLimit.limit, detectedAt: this.deps.clock.now() };
    const text = usageLimit.kind === "rejected" ? "Usage limit reached." : "The subscription started using paid usage credits; paused for your decision.";
    this.appendTimeline(sessionId, "notice", text, { data: usageLimit });
    this.patch(sessionId, { status: "usage_limit", endReason: "usage_limit", usageLimit });
    const session = this.get(sessionId);
    this.deps.bus.emit({ type: "notify", title: `${session.name}: usage limit`, body: text, sessionId });
    this.deps.lifecycle.lifecycle("session.usage_limit", session, text);
    void live.query?.interrupt().catch(() => undefined);
    live.input.close();
  }

  private onResult(sessionId: string, live: LiveSession, result: ResultInfo): void {
    this.patch(sessionId, { costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    if (result.stopReason === "tool_deferred" || live.deferring) {
      live.deferring = true;
      live.input.close();
      return;
    }
    if (live.limitStopped || live.stopping) {
      live.input.close();
      return;
    }
    const failed = result.isError || (result.subtype !== "success" && result.subtype !== "error_max_turns" && result.subtype !== "error_max_budget_usd");
    if (failed) {
      this.patch(sessionId, { status: "error", endReason: "error", errorMessage: truncateText(result.text || result.subtype, 2000) });
      this.deps.lifecycle.lifecycle("session.error", this.get(sessionId), result.text || null);
    } else {
      const endReason = result.subtype === "error_max_turns" ? "max_turns" : result.subtype === "error_max_budget_usd" ? "budget_exhausted" : "completed";
      this.patch(sessionId, { status: "done", endReason, errorMessage: null });
      this.deps.lifecycle.lifecycle("session.completed", this.get(sessionId), result.text || null);
    }
    this.scheduleIdleClose(live);
  }

  private scheduleIdleClose(live: LiveSession): void {
    live.idleTimer?.cancel();
    const minutes = this.deps.settings().warmIdleMinutes;
    if (minutes === 0) {
      live.input.close();
      return;
    }
    live.idleTimer = this.deps.clock.setTimeout(() => live.input.close(), minutes * MINUTE_MS);
  }

  private onProcessEnd(sessionId: string, live: LiveSession, failure: unknown): void {
    live.idleTimer?.cancel();
    if (this.live.get(sessionId) === live) this.live.delete(sessionId);
    const row = this.deps.store.getSession(sessionId);
    if (!row) return;
    for (const request of this.deps.store.requestsForSession(sessionId)) {
      if (request.state === "open") this.cancelRequest(request, "engine");
    }
    if (live.deferring && !live.stopping) {
      this.patch(sessionId, { status: "deferred", endReason: null });
      this.deps.lifecycle.lifecycle("session.deferred", this.get(sessionId), null);
      return;
    }
    if (live.stopping || live.limitStopped || row.status === "done" || row.status === "error" || row.status === "usage_limit") {
      this.emitSession(sessionId);
      return;
    }
    const message = failure instanceof Error ? failure.message : failure ? String(failure) : "The Claude process exited unexpectedly.";
    log.warn("session process ended unexpectedly", { sessionId, err: failure });
    this.patch(sessionId, { status: "error", endReason: "process_exit", errorMessage: truncateText(message, 2000) });
    this.deps.lifecycle.lifecycle("session.error", this.get(sessionId), message);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private refreshWaitingStatus(sessionId: string): void {
    const row = this.deps.store.getSession(sessionId);
    const externallyActive = row?.origin === "hook" && (row.status === "running" || row.status === "idle" || row.status.startsWith("waiting"));
    if (!row || (!this.live.has(sessionId) && !externallyActive)) {
      this.emitSession(sessionId);
      return;
    }
    if (row.status === "done" || row.status === "error" || row.status === "usage_limit") return;
    const open = this.deps.store.requestsForSession(sessionId).filter((request) => request.state === "open");
    const status: SessionStatus = open.some((r) => r.kind === "question")
      ? "waiting_input"
      : open.some((r) => r.kind === "permission")
        ? "waiting_permission"
        : "running";
    this.patch(sessionId, { status });
  }

  private patch(sessionId: string, patch: Partial<SessionRow>): void {
    this.deps.store.updateSession(sessionId, { ...patch, lastActivityAt: this.deps.clock.now() });
    this.emitSession(sessionId);
  }

  private emitSession(sessionId: string): void {
    const row = this.deps.store.getSession(sessionId);
    if (row) this.deps.bus.emit({ type: "session.upsert", session: this.summary(row) });
  }

  private emitRequest(requestId: string): void {
    const request = this.deps.store.getRequest(requestId);
    if (request) this.deps.bus.emit({ type: "request.upsert", request: this.publicRequest(request) });
  }

  appendTimeline(sessionId: string, kind: TimelineEvent["kind"], text: string, extra: { toolName?: string | null; toolUseId?: string | null; data?: unknown } = {}): void {
    const event = this.deps.store.appendEvent({
      sessionId,
      ts: this.deps.clock.now(),
      kind,
      text,
      toolName: extra.toolName ?? null,
      toolUseId: extra.toolUseId ?? null,
      data: extra.data ?? null,
    });
    this.deps.bus.emit({ type: "session.timeline", event });
  }

  publicRequest(request: StoredRequest): PendingRequest {
    return {
      id: request.id,
      sessionId: request.sessionId,
      kind: request.kind,
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      inputPreview: request.kind === "permission" ? previewToolInput(request.toolName, request.input) : "",
      questions: request.questions,
      canAllowForSession: request.kind === "permission",
      blockedPath: request.blockedPath,
      state: request.state,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      policy: request.policy,
    };
  }

  private requireRow(sessionId: string): SessionRow {
    const row = this.deps.store.getSession(sessionId);
    if (!row) throw new EngineError("NOT_FOUND", "Session not found");
    return row;
  }

  private profile(profileId: string): ClaudeProfile {
    const profile = this.deps.settings().profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new EngineError("BAD_REQUEST", `Unknown profile: ${profileId}`);
    return profile;
  }

  audit(actor: Actor, action: string, sessionId: string | null, requestId: string | null, detail: string): void {
    this.deps.store.audit({ ts: this.deps.clock.now(), actor: actor.id, action, sessionId, requestId, detail });
  }
}
