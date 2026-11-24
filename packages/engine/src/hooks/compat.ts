/**
 * Compatibility mode: sessions run by external `claude -p` processes report in through Claude Code
 * hooks (via `hubctl hook <Event>`). The hub observes them and answers their permission requests.
 */
import { z } from "zod";
import type { SessionRow } from "../db.ts";
import type { EngineSettings, RequestAnswer } from "@hub/protocol";
import type { Clock } from "../clock.ts";
import { EngineError } from "../errors.ts";
import { expandHome } from "../claude.ts";
import { isInside } from "../paths.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { permissionResult, sessionScopedUpdates } from "../permissions.ts";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { homedir } from "node:os";

/** Entrypoints of non-interactive runs. Interactive terminal sessions are intentionally ignored. */
const HEADLESS_ENTRYPOINTS = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);
/** PermissionRequest hooks default to a 600 s timeout; answer just before it so Claude gets our decision, not a hook failure. */
export const PERMISSION_HOOK_BUDGET_MS = 570_000;

const BaseHook = z.object({
  session_id: z.string().uuid(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  hook_event_name: z.string(),
});

export const HookEnvelope = z.object({
  event: z.enum(["SessionStart", "SessionEnd", "Stop", "Notification", "PermissionRequest"]),
  entrypoint: z.string().nullable(),
  /** Set by `hubctl run`: registers the session even if the entrypoint is unknown. */
  hubRun: z.object({ name: z.string().max(120).optional(), labels: z.array(z.string().max(48)).max(16).optional() }).nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type HookEnvelope = z.infer<typeof HookEnvelope>;

export type HookResponse = Record<string, unknown>;

export class CompatLayer {
  constructor(
    private readonly manager: SessionManager,
    private readonly clock: Clock,
    private readonly settings: () => EngineSettings,
  ) {}

  async handle(envelope: HookEnvelope, signal: AbortSignal): Promise<HookResponse> {
    const base = BaseHook.safeParse(envelope.payload);
    if (!base.success) throw new EngineError("BAD_REQUEST", "Invalid hook payload");
    const existing = this.manager.store.getSession(base.data.session_id);
    if (existing?.origin === "app") return {}; // our own SDK sessions are handled by canUseTool
    const tracked = existing ?? (this.shouldTrack(envelope) ? this.register(envelope, base.data) : null);
    if (!tracked) return {};
    switch (envelope.event) {
      case "SessionStart":
        this.manager.compatStatus(tracked.id, "running", null);
        return {};
      case "Notification":
        return this.onNotification(tracked, envelope.payload);
      case "Stop": {
        const last = typeof envelope.payload.last_assistant_message === "string" ? envelope.payload.last_assistant_message : null;
        if (last) this.manager.appendTimeline(tracked.id, "assistant_text", last);
        this.manager.compatStatus(tracked.id, "idle", null);
        return {};
      }
      case "SessionEnd":
        this.manager.compatEnd(tracked.id, String(envelope.payload.reason ?? "other"));
        return {};
      case "PermissionRequest":
        return this.onPermissionRequest(tracked, envelope.payload, signal);
    }
  }

  private shouldTrack(envelope: HookEnvelope): boolean {
    if (envelope.hubRun) return true;
    return envelope.entrypoint !== null && HEADLESS_ENTRYPOINTS.has(envelope.entrypoint);
  }

  private register(envelope: HookEnvelope, base: z.infer<typeof BaseHook>): SessionRow {
    const now = this.clock.now();
    const cwd = base.cwd ?? "";
    const row: SessionRow = {
      id: base.session_id,
      name: envelope.hubRun?.name?.trim() || `claude -p · ${path.basename(cwd) || "session"}`,
      labels: envelope.hubRun?.labels ?? [],
      cwd,
      profileId: this.profileForTranscript(base.transcript_path ?? null),
      model: null,
      permissionMode: base.permission_mode ?? null,
      origin: "hook",
      status: "running",
      endReason: null,
      errorMessage: null,
      usageLimit: null,
      createdAt: now,
      lastActivityAt: now,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastMessagePreview: null,
      launch: { permissionMode: base.permission_mode ?? "default" },
    };
    this.manager.compatRegister(row);
    return row;
  }

  /** Transcripts live under <configDir>/projects/…; match that against the configured profiles. */
  private profileForTranscript(transcriptPath: string | null): string {
    const settings = this.settings();
    if (transcriptPath) {
      for (const profile of settings.profiles) {
        const root = profile.configDir ? expandHome(profile.configDir) : path.join(homedir(), ".claude");
        if (isInside(transcriptPath, root)) return profile.id;
      }
    }
    return settings.defaultProfileId;
  }

  private onNotification(row: SessionRow, payload: Record<string, unknown>): HookResponse {
    const type = String(payload.notification_type ?? "");
    const message = typeof payload.message === "string" ? payload.message : "";
    if (message) this.manager.appendTimeline(row.id, "notice", message);
    if (type === "idle_prompt") this.manager.compatStatus(row.id, "idle", null);
    return {};
  }

  private async onPermissionRequest(row: SessionRow, payload: Record<string, unknown>, signal: AbortSignal): Promise<HookResponse> {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
    const toolInput = (payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {}) as Record<string, unknown>;
    const suggestions = Array.isArray(payload.permission_suggestions) ? (payload.permission_suggestions as PermissionUpdate[]) : null;
    const timeout = AbortSignal.timeout(PERMISSION_HOOK_BUDGET_MS);
    const combined = AbortSignal.any([signal, timeout]);
    const answer = await this.manager.compatAwaitPermission(row.id, toolName, toolInput, suggestions, combined);
    if (!answer) return {}; // no decision → Claude Code falls back to its own behaviour (deny in -p)
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: this.toDecision(answer, toolInput, suggestions) } };
  }

  private toDecision(answer: RequestAnswer, input: Record<string, unknown>, suggestions: PermissionUpdate[] | null): Record<string, unknown> {
    if (answer.kind !== "permission") return { behavior: "deny", message: "Unexpected answer" };
    const result = permissionResult(answer, input, suggestions);
    if (result.behavior === "deny") return { behavior: "deny", message: result.message };
    const scoped = answer.decision === "allow_session" ? sessionScopedUpdates(suggestions) : [];
    return scoped.length > 0 ? { behavior: "allow", updatedPermissions: scoped } : { behavior: "allow" };
  }
}

