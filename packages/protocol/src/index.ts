/** Wire contract shared by the engine, the desktop UI and peer devices. Single source of truth. */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Hard limits from the AskUserQuestion tool contract: 1–4 questions, 2–4 options each. */
export const MAX_QUESTIONS_PER_CALL = 4;
export const MAX_OPTIONS_PER_QUESTION = 4;
const MAX_LABELS = 16;
const MAX_LABEL_LENGTH = 48;
const MAX_NAME_LENGTH = 120;
const MAX_PROMPT_LENGTH = 200_000;

// ── Session status ───────────────────────────────────────────────────────────

export const SessionStatus = z.enum([
  "starting",
  "running",
  "waiting_input",
  "waiting_permission",
  "idle",
  "done",
  "error",
  "usage_limit",
  "deferred",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Statuses that need a human; the session list pins these to the top. */
export const ATTENTION_STATUSES: readonly SessionStatus[] = [
  "waiting_input",
  "waiting_permission",
  "usage_limit",
  "deferred",
];

/** How the session entered the hub: launched by the engine, or observed through Claude Code hooks. */
export const SessionOrigin = z.enum(["app", "hook"]);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

export const PermissionMode = z.enum(["default", "acceptEdits", "plan", "dontAsk", "auto"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const EndReason = z.enum([
  "completed",
  "stopped_by_user",
  "error",
  "usage_limit",
  "auth_blocked",
  "max_turns",
  "budget_exhausted",
  "engine_restart",
  "process_exit",
]);
export type EndReason = z.infer<typeof EndReason>;

export const UsageLimitInfo = z.object({
  kind: z.enum(["rejected", "overage"]),
  resetsAt: z.number().int().nullable(),
  limitType: z.string().nullable(),
  detectedAt: z.number().int(),
});
export type UsageLimitInfo = z.infer<typeof UsageLimitInfo>;

export const SessionSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  labels: z.array(z.string()),
  cwd: z.string(),
  profileId: z.string(),
  model: z.string().nullable(),
  permissionMode: z.string().nullable(),
  origin: SessionOrigin,
  status: SessionStatus,
  endReason: EndReason.nullable(),
  errorMessage: z.string().nullable(),
  usageLimit: UsageLimitInfo.nullable(),
  createdAt: z.number().int(),
  lastActivityAt: z.number().int(),
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  openRequests: z.number().int(),
  lastMessagePreview: z.string().nullable(),
  /** True while a live process can take input; false means a message triggers --resume. */
  live: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

// ── Timeline ─────────────────────────────────────────────────────────────────

export const TimelineKind = z.enum([
  "user_message",
  "assistant_text",
  "thinking",
  "tool_use",
  "tool_result",
  "request_opened",
  "request_closed",
  "status",
  "result",
  "error",
  "notice",
]);
export type TimelineKind = z.infer<typeof TimelineKind>;

export const TimelineEvent = z.object({
  seq: z.number().int(),
  sessionId: z.string().uuid(),
  ts: z.number().int(),
  kind: TimelineKind,
  /** Display text, already masked when it leaves the device. */
  text: z.string(),
  toolName: z.string().nullable(),
  toolUseId: z.string().nullable(),
  /** Set for events inside a subagent: the id of the Agent/Task tool call that spawned it. */
  parentToolUseId: z.string().nullable(),
  /** Structured details (tool input, result stats). Masked on egress. */
  data: z.unknown().nullable(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

/** `data` of a "status" event that tracks a subagent (parentToolUseId = its Agent tool call). */
export interface SubagentStatusData {
  subagent: {
    state: "started" | "progress" | "completed" | "failed" | "stopped";
    description: string;
    subagentType: string | null;
    summary: string | null;
    toolUses: number | null;
    totalTokens: number | null;
  };
}

/** Tool names that spawn a subagent. */
export const SUBAGENT_TOOLS: readonly string[] = ["Agent", "Task"];

// ── Pending requests (questions + permissions) ───────────────────────────────

export const QuestionOption = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export const Question = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(QuestionOption).min(2).max(MAX_OPTIONS_PER_QUESTION),
  multiSelect: z.boolean(),
});
export type Question = z.infer<typeof Question>;

export const RequestState = z.enum(["open", "answered", "expired", "deferred", "cancelled"]);
export type RequestState = z.infer<typeof RequestState>;

export const PendingRequest = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  kind: z.enum(["question", "permission"]),
  toolName: z.string(),
  toolUseId: z.string().nullable(),
  /** Masked preview of the tool input for permission cards. */
  inputPreview: z.string(),
  questions: z.array(Question).max(MAX_QUESTIONS_PER_CALL).nullable(),
  /** Whether "always allow in this session" can be offered. */
  canAllowForSession: z.boolean(),
  blockedPath: z.string().nullable(),
  /** Set when a subagent (not the main conversation) asked. */
  agentId: z.string().nullable(),
  state: RequestState,
  createdAt: z.number().int(),
  expiresAt: z.number().int().nullable(),
  policy: z.lazy(() => WaitPolicy),
});
export type PendingRequest = z.infer<typeof PendingRequest>;

export const QuestionAnswer = z.object({
  kind: z.literal("question"),
  /** Keyed by question text. multiSelect answers are arrays of labels; free text is a plain string. */
  answers: z.record(z.string(), z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])),
});
export const PermissionAnswer = z.object({
  kind: z.literal("permission"),
  decision: z.enum(["allow", "allow_session", "deny"]),
  message: z.string().max(2000).optional(),
});
export const RequestAnswer = z.discriminatedUnion("kind", [QuestionAnswer, PermissionAnswer]);
export type RequestAnswer = z.infer<typeof RequestAnswer>;

// ── Policies & settings ──────────────────────────────────────────────────────

export const WaitPolicy = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("wait") }),
  z.object({ mode: z.literal("deny_after"), minutes: z.number().int().min(1).max(10_080) }),
  z.object({ mode: z.literal("defer_after"), minutes: z.number().int().min(1).max(10_080) }),
]);
export type WaitPolicy = z.infer<typeof WaitPolicy>;

export const WebhookEvent = z.enum([
  "session.started",
  "session.waiting",
  "session.completed",
  "session.error",
  "session.usage_limit",
  "session.deferred",
]);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const WebhookConfig = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  events: z.array(WebhookEvent).min(1),
  /** HMAC-SHA256 signing secret; never echoed back to peers. */
  secret: z.string().min(16).max(256),
  enabled: z.boolean(),
});
export type WebhookConfig = z.infer<typeof WebhookConfig>;

/** A Claude Code login on this machine: a CLAUDE_CONFIG_DIR (null = the CLI default, ~/.claude). */
export const ClaudeProfile = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1).max(60),
  configDir: z.string().min(1).nullable(),
});
export type ClaudeProfile = z.infer<typeof ClaudeProfile>;

export const DEFAULT_PROFILE_ID = "default";

export const EngineSettings = z.object({
  profiles: z.array(ClaudeProfile).min(1),
  defaultProfileId: z.string(),
  allowedDirectories: z.array(z.string()),
  defaultWaitPolicy: WaitPolicy,
  /** Minutes a finished session keeps its process warm before closing. */
  warmIdleMinutes: z.number().int().min(0).max(240),
  /** Stop and ask when the subscription starts spending usage credits. */
  pauseOnOverage: z.boolean(),
  /** Explicit owner approval to run with a non-subscription auth method. */
  allowNonSubscriptionAuth: z.boolean(),
  /** Peers receive status and metadata only, never tool inputs/outputs. */
  summaryOnlyForPeers: z.boolean(),
  eventRetentionDays: z.number().int().min(1).max(3650),
  claudePath: z.string().nullable(),
  webhooks: z.array(WebhookConfig),
});
export type EngineSettings = z.infer<typeof EngineSettings>;

export const DEFAULT_SETTINGS: EngineSettings = {
  profiles: [{ id: DEFAULT_PROFILE_ID, name: "Default", configDir: null }],
  defaultProfileId: DEFAULT_PROFILE_ID,
  allowedDirectories: [],
  defaultWaitPolicy: { mode: "wait" },
  warmIdleMinutes: 10,
  pauseOnOverage: true,
  allowNonSubscriptionAuth: false,
  summaryOnlyForPeers: false,
  eventRetentionDays: 30,
  claudePath: null,
  webhooks: [],
};

// ── Commands ─────────────────────────────────────────────────────────────────

/** Variables that switch Claude Code away from the subscription login. Never forwarded to sessions. */
export const AUTH_ENV_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CONFIG_DIR",
];

const Label = z.string().trim().min(1).max(MAX_LABEL_LENGTH);
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const StartSessionParams = z.object({
  cwd: z.string().min(1),
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  name: z.string().trim().max(MAX_NAME_LENGTH).optional(),
  profileId: z.string().optional(),
  labels: z.array(Label).max(MAX_LABELS).default([]),
  appendSystemPrompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
  permissionMode: PermissionMode.default("default"),
  model: z.string().max(100).optional(),
  allowedTools: z.array(z.string().max(200)).max(200).optional(),
  disallowedTools: z.array(z.string().max(200)).max(200).optional(),
  /** Extra environment for the session. Auth/provider variables are rejected (see AUTH_ENV_VARS). */
  env: z
    .record(EnvName, z.string().max(10_000))
    .refine((env) => Object.keys(env).every((name) => !AUTH_ENV_VARS.includes(name.toUpperCase())), {
      message: "auth and provider variables cannot be passed to a session",
    })
    .optional(),
  maxTurns: z.number().int().min(1).max(10_000).optional(),
  maxBudgetUsd: z.number().positive().max(10_000).optional(),
  waitPolicy: WaitPolicy.optional(),
});
export type StartSessionParams = z.input<typeof StartSessionParams>;

export const ListSessionsParams = z.object({
  status: z.array(SessionStatus).optional(),
  label: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

export const TimelineParams = z.object({
  sessionId: z.string().uuid(),
  afterSeq: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(2000).default(500),
});

export const AnswerParams = z.object({
  sessionId: z.string().uuid(),
  requestId: z.string().uuid(),
  answer: RequestAnswer,
});

export const MessageParams = z.object({
  sessionId: z.string().uuid(),
  text: z.string().min(1).max(MAX_PROMPT_LENGTH),
});

export const SessionIdParams = z.object({ sessionId: z.string().uuid() });

export const UpdateSessionParams = z.object({
  sessionId: z.string().uuid(),
  name: z.string().trim().max(MAX_NAME_LENGTH).optional(),
  labels: z.array(Label).max(MAX_LABELS).optional(),
});

/** Every RPC method, its params schema. Results are typed in RpcResults. */
export const RpcSchemas = {
  "engine.info": z.object({}),
  "sessions.list": ListSessionsParams,
  "sessions.get": SessionIdParams,
  "sessions.timeline": TimelineParams,
  "sessions.requests": SessionIdParams,
  "sessions.start": StartSessionParams,
  "sessions.message": MessageParams,
  "sessions.answer": AnswerParams,
  "sessions.stop": SessionIdParams,
  "sessions.update": UpdateSessionParams,
  "settings.get": z.object({}),
  "settings.update": EngineSettings.partial(),
  "hooks.status": z.object({}),
  "hooks.install": z.object({ profileId: z.string() }),
  "hooks.uninstall": z.object({ profileId: z.string() }),
  "auth.refresh": z.object({}),
  "audit.list": z.object({ limit: z.number().int().min(1).max(1000).default(200) }),
} as const;
export type RpcMethod = keyof typeof RpcSchemas;
/** Params a caller sends for a method (defaults may be omitted). */
export type RpcParams<M extends RpcMethod> = z.input<(typeof RpcSchemas)[M]>;

export const AuthState = z.object({
  profileId: z.string(),
  method: z.enum(["subscription", "api_key", "third_party", "unknown", "not_logged_in"]),
  detail: z.string(),
  checkedAt: z.number().int(),
});
export type AuthState = z.infer<typeof AuthState>;

export const EngineInfo = z.object({
  protocolVersion: z.number().int(),
  engineVersion: z.string(),
  hostname: z.string(),
  platform: z.string(),
  claudePath: z.string().nullable(),
  claudeVersion: z.string().nullable(),
  auth: z.array(AuthState),
  apiPort: z.number().int().nullable(),
});
export type EngineInfo = z.infer<typeof EngineInfo>;

export const HooksStatus = z.object({
  hubctlPath: z.string().nullable(),
  profiles: z.array(z.object({ profileId: z.string(), installed: z.boolean(), settingsPath: z.string() })),
});
export type HooksStatus = z.infer<typeof HooksStatus>;

export const AuditEntry = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  actor: z.string(),
  action: z.string(),
  sessionId: z.string().nullable(),
  requestId: z.string().nullable(),
  detail: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export interface RpcResults {
  "engine.info": EngineInfo;
  "sessions.list": SessionSummary[];
  "sessions.get": SessionSummary;
  "sessions.timeline": TimelineEvent[];
  "sessions.requests": PendingRequest[];
  "sessions.start": SessionSummary;
  "sessions.message": SessionSummary;
  "sessions.answer": PendingRequest;
  "sessions.stop": SessionSummary;
  "sessions.update": SessionSummary;
  "settings.get": EngineSettings;
  "settings.update": EngineSettings;
  "hooks.status": HooksStatus;
  "hooks.install": HooksStatus;
  "hooks.uninstall": HooksStatus;
  "auth.refresh": AuthState[];
  "audit.list": AuditEntry[];
}

// ── Events pushed by the engine ──────────────────────────────────────────────

export type EngineEvent =
  | { type: "session.upsert"; session: SessionSummary }
  | { type: "session.timeline"; event: TimelineEvent }
  | { type: "request.upsert"; request: PendingRequest }
  | { type: "notify"; title: string; body: string; sessionId: string | null }
  | { type: "engine.status"; info: EngineInfo };

// ── Transport envelopes (engine stdio / peer streams) ────────────────────────

/**
 * Access level of a paired device, chosen at pairing time and changeable locally afterwards.
 * read_only: observe · operator: also drive sessions · full: also change settings and hooks.
 */
export const PeerAccess = z.enum(["read_only", "operator", "full"]);
export type PeerAccess = z.infer<typeof PeerAccess>;

/** Who is calling: the local UI, a paired peer device, the local HTTP API (hubctl/automation). */
export const Caller = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  // `access` is stamped by the local shell from its own pairing store, never taken from the peer.
  z.object({ kind: z.literal("peer"), deviceId: z.string().min(1), deviceName: z.string(), access: PeerAccess }),
  z.object({ kind: z.literal("api") }),
]);
export type Caller = z.infer<typeof Caller>;

export const RpcRequestEnvelope = z.object({
  t: z.literal("req"),
  id: z.string().min(1).max(64),
  method: z.string(),
  params: z.unknown(),
  caller: Caller,
});
export type RpcRequestEnvelope = z.infer<typeof RpcRequestEnvelope>;

export const ErrorCode = z.enum([
  "BAD_REQUEST",
  "NOT_FOUND",
  "FORBIDDEN",
  "CONFLICT",
  "DIRECTORY_NOT_ALLOWED",
  "AUTH_BLOCKED",
  "CLAUDE_NOT_FOUND",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export type RpcResponseEnvelope =
  | { t: "res"; id: string; ok: true; result: unknown }
  | { t: "res"; id: string; ok: false; error: { code: ErrorCode; message: string } };

export type EventEnvelope = { t: "evt"; event: EngineEvent };

export type EngineOutbound = RpcResponseEnvelope | EventEnvelope | { t: "ready"; info: EngineInfo };
