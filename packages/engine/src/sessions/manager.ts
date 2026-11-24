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
  type PermissionMode as PermissionModeValue,
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
import { ASK_TOOL_HINT, endsWithQuestion } from "./questions.ts";
import { translate, truncateText, type ResultInfo, type Translation } from "./translate.ts";

const MINUTE_MS = 60_000;
/** Upper bound for one wait inside a hook; matches the longest configurable wait policy (7 days). */
const HOOK_WAIT_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
const INTERRUPT_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 10_000;
const DEFAULT_NAME_CHARS = 60;
const LIVE_STATUSES: readonly SessionStatus[] = ["starting", "running", "waiting_input", "waiting_permission", "idle"];
/** Bounds the queue of a session that cannot take input yet; each message is already length-limited. */
const MAX_QUEUED_MESSAGES = 50;
const QUEUE_ACTOR: Actor = { id: "queue" };

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
  | { type: "cancelled" }
  /** The owner wrote a message instead of using the card; `reply` carries it to this request, if any. */
  | { type: "superseded"; reply: string | null };

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
  /** Last progress summary per subagent, so repeated identical summaries are not stored. */
  subagentSummaries: Map<string, string>;
  /**
   * Background tasks (e.g. backgrounded subagents) still running. A result while this is > 0 is not the
   * end: closing the input then would kill that work. The CLI starts another turn when they finish.
   */
  backgroundTasks: number;
  /** Full text of the main conversation's latest assistant message, for plain-question detection. */
  lastAssistantText: string | null;
}

export interface Actor {
  id: string;
}

function approvalKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}\u0000${JSON.stringify(input)}`;
}

/** What Claude reads when the owner answered a card by writing a message instead. */
function supersededReason(kind: "question" | "permission", reply: string | null): string {
  if (reply === null) {
    return kind === "question"
      ? "The user did not answer this question; they sent a message instead, which follows."
      : "The user did not approve this call; they sent a message instead, which follows.";
  }
  return kind === "question"
    ? `The user did not pick an option and replied in their own words instead. Treat this as their answer:\n\n${reply}`
    : `The user did not approve this call and replied instead. Follow their reply:\n\n${reply}`;
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
    const permissionMode = params.permissionMode ?? settings.defaultPermissionMode;
    const model = params.model ?? settings.defaultModel ?? undefined;
    const launch: LaunchConfig = {
      permissionMode,
      ...(model ? { model } : {}),
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
      model: model ?? null,
      permissionMode,
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
      awaitingReply: false,
      queuedMessages: [],
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

  /**
   * Sends a message. Input is never refused for being "busy", as in Claude Code itself:
   * - live process: written straight in; an open question/permission card is answered by the message;
   * - external claude -p process still running: an open permission is answered by it, otherwise it is queued
   *   and sent when that process ends;
   * - hub process closing: queued and sent once it has closed;
   * - otherwise: resumes the session with it (plus anything queued before).
   */
  async message(sessionId: string, text: string, actor: Actor): Promise<SessionSummary> {
    const row = this.requireRow(sessionId);
    this.audit(actor, "session.message", sessionId, null, `chars=${text.length}`);
    const live = this.live.get(sessionId);
    if (live && !live.input.isClosed && !live.stopping) {
      live.idleTimer?.cancel();
      live.idleTimer = null;
      live.lastAssistantText = null;
      this.appendTimeline(sessionId, "user_message", text);
      if (!this.supersedeOpenRequests(sessionId, text, actor)) live.input.pushText(text);
      this.patch(sessionId, { status: "running", endReason: null, errorMessage: null, awaitingReply: false });
      return this.get(sessionId);
    }
    if (live) return this.enqueue(row, text);
    const externalRunEnded = ["done", "error", "usage_limit"].includes(row.status) || (row.awaitingReply && row.endReason !== null);
    if (row.origin === "hook" && !externalRunEnded) {
      if (this.supersedeOpenRequests(sessionId, text, actor)) {
        this.appendTimeline(sessionId, "user_message", text);
        return this.get(sessionId);
      }
      return this.enqueue(row, text);
    }
    return this.resumeWith(row, [...row.queuedMessages, text], actor);
  }

  /** Drops queued messages without sending them. */
  clearQueue(sessionId: string, actor: Actor): SessionSummary {
    const row = this.requireRow(sessionId);
    if (row.queuedMessages.length > 0) {
      this.audit(actor, "session.queue_clear", sessionId, null, `count=${row.queuedMessages.length}`);
      this.patch(sessionId, { queuedMessages: [] });
    }
    return this.get(sessionId);
  }

  private enqueue(row: SessionRow, text: string): SessionSummary {
    if (row.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
      throw new EngineError("CONFLICT", `At most ${MAX_QUEUED_MESSAGES} messages can wait in the queue.`);
    }
    this.patch(row.id, { queuedMessages: [...row.queuedMessages, text] });
    return this.get(row.id);
  }

  private async resumeWith(row: SessionRow, messages: readonly string[], actor: Actor): Promise<SessionSummary> {
    const sessionId = row.id;
    const text = messages.join("\n\n");
    // A new prompt supersedes anything deferred: Claude answers the prompt and skips the parked call.
    for (const request of this.deps.store.requestsForSession(sessionId)) {
      if (request.state === "deferred" || request.state === "open") this.cancelRequest(request, actor.id);
    }
    const profile = this.profile(row.profileId);
    if (row.origin === "hook") {
      // Resuming runs Claude inside the hub in that directory, so the allowlist applies as for a new session.
      await assertAllowedDirectory(row.cwd, this.deps.settings().allowedDirectories);
    }
    await this.preflight(profile, actor, sessionId);
    for (const message of messages) this.appendTimeline(sessionId, "user_message", message);
    this.patch(sessionId, { status: "starting", endReason: null, errorMessage: null, usageLimit: null, awaitingReply: false, queuedMessages: [] });
    this.launch(row, profile, { kind: "resume", prompt: text });
    return this.get(sessionId);
  }

  /** Sends what was queued once the session can continue. Failures keep the queue and say why. */
  private async drainQueue(sessionId: string): Promise<void> {
    const row = this.deps.store.getSession(sessionId);
    if (!row || row.queuedMessages.length === 0 || this.live.has(sessionId)) return;
    if (row.status === "error" || row.status === "usage_limit") {
      this.appendTimeline(sessionId, "notice", "Queued messages were not sent because the run ended with an error or a usage limit. Send a new message to continue with them.");
      return;
    }
    try {
      await this.resumeWith(row, row.queuedMessages, QUEUE_ACTOR);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn("queued messages could not be sent", { sessionId, err });
      this.appendTimeline(sessionId, "notice", `Queued messages could not be sent: ${reason}`);
      this.emitSession(sessionId);
    }
  }

  /**
   * A message written while a card is open answers it, as typing a reply does in Claude Code. The first
   * main-conversation request carries the text; any others are closed so the turn is not stuck on them.
   * Returns false when no request carried the text (none open, or only subagent ones): the caller sends it.
   */
  private supersedeOpenRequests(sessionId: string, text: string, actor: Actor): boolean {
    const open = this.deps.store.requestsForSession(sessionId).filter((request) => request.state === "open" && this.waiters.has(request.id));
    if (open.length === 0) return false;
    const carrier = open.find((request) => request.agentId === null) ?? null;
    for (const request of open) {
      const waiter = this.waiters.get(request.id);
      if (!this.closeRequest(request, "cancelled", null, actor.id)) continue;
      this.audit(actor, "request.superseded", sessionId, request.id, request === carrier ? "carried_reply" : "");
      waiter?.resolve({ type: "superseded", reply: request === carrier ? text : null });
    }
    return carrier !== null;
  }

  async stop(sessionId: string, actor: Actor): Promise<SessionSummary> {
    this.requireRow(sessionId);
    this.audit(actor, "session.stop", sessionId, null, "");
    for (const request of this.deps.store.requestsForSession(sessionId)) {
      if (request.state === "open" || request.state === "deferred") this.cancelRequest(request, actor.id);
    }
    const live = this.live.get(sessionId);
    this.patch(sessionId, { status: "done", endReason: "stopped_by_user", queuedMessages: [] });
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

  /** Changes model and/or permission mode: live on a running process, and for every later resume. */
  async configure(sessionId: string, change: { model?: string | null | undefined; permissionMode?: PermissionModeValue | undefined }, actor: Actor): Promise<SessionSummary> {
    const row = this.requireRow(sessionId);
    const launch: LaunchConfig = { ...row.launch };
    const patch: Partial<SessionRow> = {};
    if (change.model !== undefined) {
      if (change.model === null) delete launch.model;
      else launch.model = change.model;
      patch.model = change.model;
    }
    if (change.permissionMode !== undefined) {
      launch.permissionMode = change.permissionMode;
      patch.permissionMode = change.permissionMode;
    }
    this.deps.store.updateSession(sessionId, { launch });
    const query = this.live.get(sessionId)?.query;
    if (query) {
      if (change.model !== undefined) await query.setModel(change.model ?? undefined);
      if (change.permissionMode !== undefined) await query.setPermissionMode(change.permissionMode);
    }
    this.audit(actor, "session.configure", sessionId, null, JSON.stringify(change));
    this.patch(sessionId, patch);
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
      if (row.awaitingReply) continue; // a plain-text question survives restarts; the reply resumes the session
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

  compatUpdate(sessionId: string, patch: Partial<SessionRow>): void {
    this.patch(sessionId, patch);
  }

  compatEnd(sessionId: string, reason: string): void {
    this.recordExternalEnd(sessionId, reason);
    void this.drainQueue(sessionId);
  }

  private recordExternalEnd(sessionId: string, reason: string): void {
    for (const request of this.deps.store.requestsForSession(sessionId)) {
      if (request.state === "open") this.cancelRequest(request, "hook");
    }
    const row = this.deps.store.getSession(sessionId);
    if (!row || row.status === "error" || row.status === "usage_limit") return;
    if (row.awaitingReply) {
      // The external process is gone but its question stands; a reply resumes it inside the hub.
      this.patch(sessionId, { endReason: "completed" });
      return;
    }
    this.patch(sessionId, { status: "done", endReason: "completed" });
    this.appendTimeline(sessionId, "notice", `Session ended (${reason}).`);
    if (row.queuedMessages.length === 0) this.deps.lifecycle.lifecycle("session.completed", this.get(sessionId), row.lastMessagePreview);
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
    if (outcome.type === "superseded") return { kind: "permission", decision: "deny", message: supersededReason("permission", outcome.reply) };
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
      subagentSummaries: new Map(),
      backgroundTasks: 0,
      lastAssistantText: null,
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
      systemPrompt: this.systemPrompt(launch.appendSystemPrompt),
      canUseTool: this.canUseTool(row.id, live),
      hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [askHook], timeout: HOOK_WAIT_TIMEOUT_SECONDS, onFailure: "block" }] },
      // Full subagent transcripts (text and thinking, not just tool calls) for the nested conversation view.
      forwardSubagentText: true,
      agentProgressSummaries: true,
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

  private systemPrompt(append: string | undefined): NonNullable<Options["systemPrompt"]> {
    const parts = [this.deps.settings().askViaTool ? ASK_TOOL_HINT : null, append ?? null].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? { type: "preset", preset: "claude_code", append: parts.join("\n\n") } : { type: "preset", preset: "claude_code" };
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
      case "superseded":
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: supersededReason("question", outcome.reply) } };
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
      const request = this.openRequest(sessionId, toolName, options.toolUseID, input, options.suggestions ?? null, options.blockedPath ?? null, undefined, options.agentID ?? null);
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
        case "superseded":
          return { behavior: "deny", message: supersededReason("permission", outcome.reply) };
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
    if (outcome.type === "superseded") return { behavior: "deny", message: supersededReason("question", outcome.reply) };
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
    agentId: string | null = null,
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
      agentId,
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
    for (const draft of translation.drafts) {
      if (draft.kind === "status" && draft.parentToolUseId) {
        const state = (draft.data as { subagent?: { state?: string } } | null)?.subagent?.state;
        if (state === "progress" && live.subagentSummaries.get(draft.parentToolUseId) === draft.text) continue;
        live.subagentSummaries.set(draft.parentToolUseId, draft.text);
      }
      if (draft.kind === "assistant_text" && draft.parentToolUseId === null) live.lastAssistantText = draft.text;
      this.appendTimeline(sessionId, draft.kind, draft.text, draft);
    }
    const patch: Partial<SessionRow> = {};
    if (translation.preview) patch.lastMessagePreview = translation.preview;
    if (translation.init) this.onInit(sessionId, live, translation.init, patch);
    if (translation.rateLimit) this.onRateLimit(sessionId, live, translation.rateLimit);
    if (translation.backgroundTasks !== undefined) this.onBackgroundTasks(live, translation.backgroundTasks);
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
    if (live.backgroundTasks > 0) {
      // Background work is still running; the CLI reports back in a later turn.
      this.patch(sessionId, { status: "running" });
      return;
    }
    const failed = result.isError || (result.subtype !== "success" && result.subtype !== "error_max_turns" && result.subtype !== "error_max_budget_usd");
    if (failed) {
      this.patch(sessionId, { status: "error", endReason: "error", errorMessage: truncateText(result.text || result.subtype, 2000) });
      this.deps.lifecycle.lifecycle("session.error", this.get(sessionId), result.text || null);
    } else {
      const endReason = result.subtype === "error_max_turns" ? "max_turns" : result.subtype === "error_max_budget_usd" ? "budget_exhausted" : "completed";
      if (endReason === "completed" && endsWithQuestion(live.lastAssistantText ?? result.text)) {
        this.markAwaitingReply(sessionId, live.lastAssistantText ?? result.text);
      } else {
        this.patch(sessionId, { status: "done", endReason, errorMessage: null, awaitingReply: false });
        this.deps.lifecycle.lifecycle("session.completed", this.get(sessionId), result.text || null);
      }
    }
    this.scheduleIdleClose(live);
  }

  /** The turn ended on a plain-text question: wait for the owner instead of reporting "done". */
  markAwaitingReply(sessionId: string, question: string): void {
    this.patch(sessionId, { status: "waiting_input", awaitingReply: true, errorMessage: null });
    const session = this.get(sessionId);
    const line = question.trim().split(/\r?\n/).filter(Boolean).pop() ?? question;
    this.deps.bus.emit({ type: "notify", title: `${session.name} soru soruyor`, body: truncateText(line, 200), sessionId });
    this.deps.lifecycle.lifecycle("session.waiting", session, line);
  }

  private onBackgroundTasks(live: LiveSession, count: number): void {
    live.backgroundTasks = count;
    // Keep a finished-but-busy process alive; the idle timer only runs once nothing is in flight.
    if (count > 0) {
      live.idleTimer?.cancel();
      live.idleTimer = null;
    }
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
    this.recordProcessEnd(sessionId, live, failure);
    void this.drainQueue(sessionId);
  }

  private recordProcessEnd(sessionId: string, live: LiveSession, failure: unknown): void {
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
    if (live.stopping || live.limitStopped || row.status === "done" || row.status === "error" || row.status === "usage_limit" || row.awaitingReply) {
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

  appendTimeline(sessionId: string, kind: TimelineEvent["kind"], text: string, extra: { toolName?: string | null; toolUseId?: string | null; parentToolUseId?: string | null; data?: unknown } = {}): void {
    const event = this.deps.store.appendEvent({
      sessionId,
      ts: this.deps.clock.now(),
      kind,
      text,
      toolName: extra.toolName ?? null,
      toolUseId: extra.toolUseId ?? null,
      parentToolUseId: extra.parentToolUseId ?? null,
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
      agentId: request.agentId,
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
