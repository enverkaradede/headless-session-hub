/** SQLite persistence (node:sqlite) for sessions, timeline, pending requests, audit and settings. */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  DEFAULT_SETTINGS,
  EngineSettings,
  type AuditEntry,
  type EndReason,
  type PendingRequest,
  type Question,
  type RequestAnswer,
  type RequestState,
  type SessionOrigin,
  type SessionStatus,
  type SessionSummary,
  type TimelineEvent,
  type TimelineKind,
  type UsageLimitInfo,
  type WaitPolicy,
} from "@hub/protocol";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     labels TEXT NOT NULL DEFAULT '[]',
     cwd TEXT NOT NULL,
     profile_id TEXT NOT NULL,
     model TEXT,
     permission_mode TEXT,
     origin TEXT NOT NULL,
     status TEXT NOT NULL,
     end_reason TEXT,
     error_message TEXT,
     usage_limit TEXT,
     created_at INTEGER NOT NULL,
     last_activity_at INTEGER NOT NULL,
     cost_usd REAL NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     last_message_preview TEXT,
     launch TEXT NOT NULL DEFAULT '{}'
   );
   CREATE INDEX sessions_activity ON sessions(last_activity_at DESC);
   CREATE TABLE events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     ts INTEGER NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     tool_name TEXT,
     tool_use_id TEXT,
     data TEXT
   );
   CREATE INDEX events_session ON events(session_id, seq);
   CREATE INDEX events_ts ON events(ts);
   CREATE TABLE requests (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     tool_name TEXT NOT NULL,
     tool_use_id TEXT,
     input TEXT NOT NULL,
     questions TEXT,
     suggestions TEXT,
     blocked_path TEXT,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER,
     policy TEXT NOT NULL,
     answer TEXT,
     answered_by TEXT,
     answered_at INTEGER
   );
   CREATE INDEX requests_session ON requests(session_id, state);
   CREATE INDEX requests_tool_use ON requests(tool_use_id);
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     session_id TEXT,
     request_id TEXT,
     detail TEXT NOT NULL
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v2: subagent transcripts and subagent-originated requests.
  `ALTER TABLE events ADD COLUMN parent_tool_use_id TEXT;
   CREATE INDEX events_parent ON events(session_id, parent_tool_use_id, seq);
   ALTER TABLE requests ADD COLUMN agent_id TEXT;`,
  // v3: plain-text questions at the end of a turn.
  `ALTER TABLE sessions ADD COLUMN awaiting_reply INTEGER NOT NULL DEFAULT 0;`,
];

/** Launch parameters kept so a closed session can be resumed with the same options. */
export interface LaunchConfig {
  permissionMode: string;
  model?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  env?: Record<string, string>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  waitPolicy?: WaitPolicy;
}

export interface SessionRow extends Omit<SessionSummary, "openRequests" | "live"> {
  launch: LaunchConfig;
}

export interface StoredRequest {
  id: string;
  sessionId: string;
  kind: "question" | "permission";
  toolName: string;
  toolUseId: string | null;
  input: Record<string, unknown>;
  questions: Question[] | null;
  suggestions: PermissionUpdate[] | null;
  blockedPath: string | null;
  agentId: string | null;
  state: RequestState;
  createdAt: number;
  expiresAt: number | null;
  policy: WaitPolicy;
  answer: RequestAnswer | null;
  answeredBy: string | null;
  answeredAt: number | null;
}

type Row = Record<string, SQLInputValue>;

const str = (row: Row, key: string): string => String(row[key]);
const strOrNull = (row: Row, key: string): string | null => (row[key] == null ? null : String(row[key]));
const num = (row: Row, key: string): number => Number(row[key] ?? 0);
const numOrNull = (row: Row, key: string): number | null => (row[key] == null ? null : Number(row[key]));
function json<T>(row: Row, key: string, fallback: T): T {
  const raw = row[key];
  if (raw == null) return fallback;
  return JSON.parse(String(raw)) as T;
}

function toSession(row: Row): SessionRow {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    labels: json<string[]>(row, "labels", []),
    cwd: str(row, "cwd"),
    profileId: str(row, "profile_id"),
    model: strOrNull(row, "model"),
    permissionMode: strOrNull(row, "permission_mode"),
    origin: str(row, "origin") as SessionOrigin,
    status: str(row, "status") as SessionStatus,
    endReason: strOrNull(row, "end_reason") as EndReason | null,
    errorMessage: strOrNull(row, "error_message"),
    usageLimit: json<UsageLimitInfo | null>(row, "usage_limit", null),
    createdAt: num(row, "created_at"),
    lastActivityAt: num(row, "last_activity_at"),
    costUsd: num(row, "cost_usd"),
    inputTokens: num(row, "input_tokens"),
    outputTokens: num(row, "output_tokens"),
    lastMessagePreview: strOrNull(row, "last_message_preview"),
    awaitingReply: num(row, "awaiting_reply") === 1,
    launch: json<LaunchConfig>(row, "launch", { permissionMode: "default" }),
  };
}

function toEvent(row: Row): TimelineEvent {
  return {
    seq: num(row, "seq"),
    sessionId: str(row, "session_id"),
    ts: num(row, "ts"),
    kind: str(row, "kind") as TimelineKind,
    text: str(row, "text"),
    toolName: strOrNull(row, "tool_name"),
    toolUseId: strOrNull(row, "tool_use_id"),
    parentToolUseId: strOrNull(row, "parent_tool_use_id"),
    data: json<unknown>(row, "data", null),
  };
}

function toRequest(row: Row): StoredRequest {
  return {
    id: str(row, "id"),
    sessionId: str(row, "session_id"),
    kind: str(row, "kind") as "question" | "permission",
    toolName: str(row, "tool_name"),
    toolUseId: strOrNull(row, "tool_use_id"),
    input: json<Record<string, unknown>>(row, "input", {}),
    questions: json<Question[] | null>(row, "questions", null),
    suggestions: json<PermissionUpdate[] | null>(row, "suggestions", null),
    blockedPath: strOrNull(row, "blocked_path"),
    agentId: strOrNull(row, "agent_id"),
    state: str(row, "state") as RequestState,
    createdAt: num(row, "created_at"),
    expiresAt: numOrNull(row, "expires_at"),
    policy: json<WaitPolicy>(row, "policy", { mode: "wait" }),
    answer: json<RequestAnswer | null>(row, "answer", null),
    answeredBy: strOrNull(row, "answered_by"),
    answeredAt: numOrNull(row, "answered_at"),
  };
}

const SESSION_COLUMNS: Record<keyof SessionRow, string> = {
  id: "id",
  name: "name",
  labels: "labels",
  cwd: "cwd",
  profileId: "profile_id",
  model: "model",
  permissionMode: "permission_mode",
  origin: "origin",
  status: "status",
  endReason: "end_reason",
  errorMessage: "error_message",
  usageLimit: "usage_limit",
  createdAt: "created_at",
  lastActivityAt: "last_activity_at",
  costUsd: "cost_usd",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  lastMessagePreview: "last_message_preview",
  awaitingReply: "awaiting_reply",
  launch: "launch",
};
const JSON_SESSION_FIELDS = new Set<keyof SessionRow>(["labels", "usageLimit", "launch"]);

function encodeSessionValue(key: keyof SessionRow, value: unknown): SQLInputValue {
  if (JSON_SESSION_FIELDS.has(key)) return value == null ? null : JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SQLInputValue;
}

/** Thin repository over one SQLite file. All statements are parameterized. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as Row | undefined;
    const current = row ? num(row, "user_version") : 0;
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[version] ?? "");
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  // ── sessions ──
  insertSession(session: SessionRow): void {
    const keys = Object.keys(SESSION_COLUMNS) as (keyof SessionRow)[];
    const columns = keys.map((key) => SESSION_COLUMNS[key]).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    this.db
      .prepare(`INSERT INTO sessions (${columns}) VALUES (${placeholders})`)
      .run(...keys.map((key) => encodeSessionValue(key, session[key])));
  }

  updateSession(id: string, patch: Partial<Omit<SessionRow, "id">>): void {
    const keys = (Object.keys(patch) as (keyof SessionRow)[]).filter((key) => key in SESSION_COLUMNS && key !== "id");
    if (keys.length === 0) return;
    const assignments = keys.map((key) => `${SESSION_COLUMNS[key]} = ?`).join(", ");
    this.db
      .prepare(`UPDATE sessions SET ${assignments} WHERE id = ?`)
      .run(...keys.map((key) => encodeSessionValue(key, patch[key as keyof typeof patch])), id);
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? toSession(row) : null;
  }

  listSessions(limit: number): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY last_activity_at DESC LIMIT ?").all(limit) as Row[]).map(toSession);
  }

  sessionsWithStatus(statuses: readonly SessionStatus[]): SessionRow[] {
    const placeholders = statuses.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT * FROM sessions WHERE status IN (${placeholders})`).all(...statuses) as Row[]).map(toSession);
  }

  openRequestCounts(): Map<string, number> {
    const rows = this.db.prepare("SELECT session_id, COUNT(*) AS n FROM requests WHERE state = 'open' GROUP BY session_id").all() as Row[];
    return new Map(rows.map((row) => [str(row, "session_id"), num(row, "n")]));
  }

  // ── timeline ──
  appendEvent(event: Omit<TimelineEvent, "seq">): TimelineEvent {
    const result = this.db
      .prepare("INSERT INTO events (session_id, ts, kind, text, tool_name, tool_use_id, parent_tool_use_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(event.sessionId, event.ts, event.kind, event.text, event.toolName, event.toolUseId, event.parentToolUseId, event.data == null ? null : JSON.stringify(event.data));
    return { ...event, seq: Number(result.lastInsertRowid) };
  }

  timeline(sessionId: string, afterSeq: number, limit: number): TimelineEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(sessionId, afterSeq, limit) as Row[]).map(toEvent);
  }

  purgeEventsBefore(ts: number): number {
    return Number(this.db.prepare("DELETE FROM events WHERE ts < ?").run(ts).changes);
  }

  // ── requests ──
  insertRequest(request: StoredRequest): void {
    this.db
      .prepare(
        `INSERT INTO requests (id, session_id, kind, tool_name, tool_use_id, input, questions, suggestions, blocked_path, state, created_at, expires_at, policy, answer, answered_by, answered_at, agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id, request.sessionId, request.kind, request.toolName, request.toolUseId, JSON.stringify(request.input),
        request.questions ? JSON.stringify(request.questions) : null, request.suggestions ? JSON.stringify(request.suggestions) : null,
        request.blockedPath, request.state, request.createdAt, request.expiresAt, JSON.stringify(request.policy),
        request.answer ? JSON.stringify(request.answer) : null, request.answeredBy, request.answeredAt, request.agentId,
      );
  }

  /** Atomically moves an open request to a terminal state; returns false if it was no longer open (first answer wins). */
  closeRequest(id: string, state: Exclude<RequestState, "open">, answer: RequestAnswer | null, answeredBy: string | null, at: number): boolean {
    const result = this.db
      .prepare("UPDATE requests SET state = ?, answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND state IN ('open', 'deferred')")
      .run(state, answer ? JSON.stringify(answer) : null, answeredBy, at, id);
    return Number(result.changes) === 1;
  }

  markRequestDeferred(id: string): boolean {
    return Number(this.db.prepare("UPDATE requests SET state = 'deferred' WHERE id = ? AND state = 'open'").run(id).changes) === 1;
  }

  reopenRequest(id: string, expiresAt: number | null): boolean {
    return Number(this.db.prepare("UPDATE requests SET state = 'open', expires_at = ? WHERE id = ? AND state IN ('open', 'deferred')").run(expiresAt, id).changes) === 1;
  }

  getRequest(id: string): StoredRequest | null {
    const row = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Row | undefined;
    return row ? toRequest(row) : null;
  }

  requestsForSession(sessionId: string): StoredRequest[] {
    return (this.db.prepare("SELECT * FROM requests WHERE session_id = ? ORDER BY created_at").all(sessionId) as Row[]).map(toRequest);
  }

  /** The newest request for a tool call — used when a deferred call fires PreToolUse again on resume. */
  requestByToolUseId(sessionId: string, toolUseId: string): StoredRequest | null {
    const row = this.db
      .prepare("SELECT * FROM requests WHERE session_id = ? AND tool_use_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sessionId, toolUseId) as Row | undefined;
    return row ? toRequest(row) : null;
  }

  requestsInState(state: RequestState): StoredRequest[] {
    return (this.db.prepare("SELECT * FROM requests WHERE state = ?").all(state) as Row[]).map(toRequest);
  }

  // ── audit ──
  audit(entry: Omit<AuditEntry, "id">): void {
    this.db
      .prepare("INSERT INTO audit (ts, actor, action, session_id, request_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(entry.ts, entry.actor, entry.action, entry.sessionId, entry.requestId, entry.detail);
  }

  auditList(limit: number): AuditEntry[] {
    return (this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((row) => ({
      id: num(row, "id"),
      ts: num(row, "ts"),
      actor: str(row, "actor"),
      action: str(row, "action"),
      sessionId: strOrNull(row, "session_id"),
      requestId: strOrNull(row, "request_id"),
      detail: str(row, "detail"),
    }));
  }

  // ── settings ──
  loadSettings(): EngineSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'engine'").get() as Row | undefined;
    if (!row) return DEFAULT_SETTINGS;
    const parsed = EngineSettings.safeParse({ ...DEFAULT_SETTINGS, ...(JSON.parse(str(row, "value")) as object) });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  saveSettings(settings: EngineSettings): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('engine', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(settings));
  }

  /** Small key/value slot for engine internals (API token hash, etc.). */
  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(`meta:${key}`) as Row | undefined;
    return row ? str(row, "value") : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`meta:${key}`, value);
  }
}

export type { PendingRequest };
