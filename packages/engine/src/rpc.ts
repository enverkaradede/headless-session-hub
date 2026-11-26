/** Validated RPC dispatch with per-caller authorization and egress masking for peer devices. */
import { RpcSchemas, type Caller, type EngineEvent, type EngineInfo, type HooksStatus, type RpcMethod, type SessionSummary, type TimelineEvent } from "@hub/protocol";
import type { z } from "zod";
import { EngineError } from "./errors.ts";
import { inspectHooks, installHooks, settingsPathFor, uninstallHooks } from "./hooks/install.ts";
import { maskText, maskValue } from "./masking.ts";
import type { SessionManager } from "./sessions/manager.ts";
import type { CatalogService } from "./catalog.ts";
import type { SettingsService } from "./settings.ts";
import type { AuthState, EngineSettings, PeerAccess } from "@hub/protocol";

const READ_METHODS: readonly RpcMethod[] = [
  "engine.info",
  "sessions.list",
  "sessions.get",
  "sessions.timeline",
  "sessions.requests",
  "settings.get",
  "hooks.status",
  "audit.list",
];
const SESSION_CONTROL_METHODS: readonly RpcMethod[] = ["sessions.start", "sessions.message", "sessions.answer", "sessions.stop", "sessions.update", "sessions.configure", "sessions.clearQueue", "catalog.list"];
const ADMIN_METHODS: readonly RpcMethod[] = ["settings.update", "hooks.install", "hooks.uninstall", "auth.refresh"];

/** What each paired-device access level may call. The local desktop UI may call everything. */
export const PEER_ACCESS_METHODS: Record<PeerAccess, ReadonlySet<RpcMethod>> = {
  read_only: new Set(READ_METHODS),
  operator: new Set([...READ_METHODS, ...SESSION_CONTROL_METHODS]),
  full: new Set([...READ_METHODS, ...SESSION_CONTROL_METHODS, ...ADMIN_METHODS]),
};
/** hubctl, hooks and automations on this machine: read and drive sessions, no settings. */
const API_METHODS = new Set<RpcMethod>([...READ_METHODS, ...SESSION_CONTROL_METHODS]);

export function callerMayInvoke(caller: Caller, method: RpcMethod): boolean {
  if (caller.kind === "local") return true;
  if (caller.kind === "api") return API_METHODS.has(method);
  return PEER_ACCESS_METHODS[caller.access].has(method);
}

/** Timeline kinds a summary-only peer receives: no tool inputs, outputs or model text. */
const SUMMARY_KINDS = new Set<TimelineEvent["kind"]>(["status", "request_opened", "request_closed", "result", "error", "notice"]);

export interface RpcContext {
  manager: SessionManager;
  settings: SettingsService;
  info: () => EngineInfo;
  refreshAuth: () => Promise<AuthState[]>;
  hubctlPath: string | null;
  catalog: CatalogService;
}

export function actorFor(caller: Caller): { id: string } {
  if (caller.kind === "local") return { id: "local-ui" };
  if (caller.kind === "api") return { id: "local-api" };
  return { id: `peer:${caller.deviceName}#${caller.deviceId.slice(0, 12)}(${caller.access})` };
}

function isRpcMethod(method: string): method is RpcMethod {
  return Object.prototype.hasOwnProperty.call(RpcSchemas, method);
}

export class RpcDispatcher {
  constructor(private readonly ctx: RpcContext) {}

  async dispatch(method: string, rawParams: unknown, caller: Caller): Promise<unknown> {
    if (!isRpcMethod(method)) throw new EngineError("NOT_FOUND", `Unknown method: ${method}`);
    if (!callerMayInvoke(caller, method)) {
      this.ctx.manager.audit(actorFor(caller), "rpc.forbidden", null, null, method);
      const who = caller.kind === "peer" ? `a ${caller.access.replace("_", "-")} device` : `${caller.kind} callers`;
      throw new EngineError("FORBIDDEN", `${method} is not allowed for ${who}`);
    }
    const parsed = (RpcSchemas[method] as z.ZodType).safeParse(rawParams ?? {});
    if (!parsed.success) {
      throw new EngineError("BAD_REQUEST", parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; "));
    }
    const result = await this.invoke(method, parsed.data as z.output<(typeof RpcSchemas)[typeof method]>, caller);
    return caller.kind === "peer" ? this.forPeer(method, result) : result;
  }

  /** One typed handler per method; params are already validated against RpcSchemas. */
  private readonly handlers: { [M in RpcMethod]: (params: z.output<(typeof RpcSchemas)[M]>, caller: Caller) => unknown } = {
    "engine.info": () => this.ctx.info(),
    "sessions.list": (p) => this.ctx.manager.list(p),
    "sessions.get": (p) => this.ctx.manager.get(p.sessionId),
    "sessions.timeline": (p) => this.ctx.manager.timeline(p.sessionId, p.afterSeq, p.limit),
    "sessions.requests": (p) => this.ctx.manager.requests(p.sessionId),
    "sessions.start": (p, caller) => this.ctx.manager.start(p, actorFor(caller)),
    "sessions.message": (p, caller) => this.ctx.manager.message(p.sessionId, p.text, actorFor(caller)),
    "sessions.answer": (p, caller) => this.ctx.manager.answer(p.sessionId, p.requestId, p.answer, actorFor(caller)),
    "sessions.stop": (p, caller) => this.ctx.manager.stop(p.sessionId, actorFor(caller)),
    "sessions.update": (p, caller) => this.ctx.manager.update(p.sessionId, { name: p.name, labels: p.labels }, actorFor(caller)),
    "catalog.list": (p) => this.ctx.catalog.list(p),
    "sessions.clearQueue": (p, caller) => this.ctx.manager.clearQueue(p.sessionId, actorFor(caller)),
    "sessions.configure": (p, caller) => this.ctx.manager.configure(p.sessionId, { model: p.model, permissionMode: p.permissionMode }, actorFor(caller)),
    "settings.get": (_p, caller) => (caller.kind === "local" ? this.ctx.settings.get() : this.ctx.settings.redacted()),
    "settings.update": (p, caller) => {
      const updated = this.ctx.settings.update(p as Partial<EngineSettings>);
      this.ctx.manager.audit(actorFor(caller), "settings.update", null, null, Object.keys(p).join(","));
      return updated;
    },
    "hooks.status": () => this.hooksStatus(),
    "hooks.install": (p, caller) => this.changeHooks(p.profileId, "install", actorFor(caller)),
    "hooks.uninstall": (p, caller) => this.changeHooks(p.profileId, "uninstall", actorFor(caller)),
    "auth.refresh": () => this.ctx.refreshAuth(),
    "audit.list": (p) => this.ctx.manager.store.auditList(p.limit),
  };

  private invoke<M extends RpcMethod>(method: M, params: z.output<(typeof RpcSchemas)[M]>, caller: Caller): Promise<unknown> {
    const handler = this.handlers[method] as (params: z.output<(typeof RpcSchemas)[M]>, caller: Caller) => unknown;
    return Promise.resolve(handler(params, caller));
  }

  private async hooksStatus(): Promise<HooksStatus> {
    const profiles = await Promise.all(
      this.ctx.settings.get().profiles.map(async (profile) => {
        const { installed, health } = await inspectHooks(profile);
        return { profileId: profile.id, installed, health, settingsPath: settingsPathFor(profile) };
      }),
    );
    return { hubctlPath: this.ctx.hubctlPath, profiles };
  }

  private async changeHooks(profileId: string, action: "install" | "uninstall", actor: { id: string }): Promise<HooksStatus> {
    const profile = this.ctx.settings.get().profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new EngineError("NOT_FOUND", "Unknown profile");
    if (action === "install") {
      if (!this.ctx.hubctlPath) throw new EngineError("CONFLICT", "hubctl is not available in this build");
      await installHooks(profile, this.ctx.hubctlPath);
    } else {
      await uninstallHooks(profile);
    }
    this.ctx.manager.audit(actor, `hooks.${action}`, null, null, `profile=${profileId}`);
    return this.hooksStatus();
  }

  private forPeer(method: RpcMethod, result: unknown): unknown {
    const summaryOnly = this.ctx.settings.get().summaryOnlyForPeers;
    if (method === "sessions.timeline") return (result as TimelineEvent[]).flatMap((event) => maskTimelineForPeer(event, summaryOnly) ?? []);
    if (method === "sessions.requests" && summaryOnly) {
      return maskValue((result as { inputPreview: string }[]).map((request) => ({ ...request, inputPreview: "[hidden: summary-only mode]" })));
    }
    if (method === "engine.info") {
      const info = result as EngineInfo;
      return { ...info, claudePath: null, apiPort: null };
    }
    return maskValue(result);
  }
}

/** Masks (or drops, in summary-only mode) a timeline event before it leaves the device. */
export function maskTimelineForPeer(event: TimelineEvent, summaryOnly: boolean): TimelineEvent | null {
  if (summaryOnly && !SUMMARY_KINDS.has(event.kind)) return null;
  return { ...event, text: maskText(event.text), data: summaryOnly ? null : maskValue(event.data) };
}

/** The peer-safe version of an engine event, or null if a peer must not see it. */
export function peerEvent(event: EngineEvent, summaryOnly: boolean): EngineEvent | null {
  switch (event.type) {
    case "session.upsert":
      return { type: "session.upsert", session: maskValue(event.session) as SessionSummary };
    case "session.timeline": {
      const masked = maskTimelineForPeer(event.event, summaryOnly);
      return masked ? { type: "session.timeline", event: masked } : null;
    }
    case "request.upsert":
      return {
        type: "request.upsert",
        request: { ...(maskValue(event.request) as typeof event.request), ...(summaryOnly ? { inputPreview: "[hidden: summary-only mode]" } : {}) },
      };
    case "notify":
      return { ...event, title: maskText(event.title), body: maskText(event.body) };
    case "engine.status":
      return { type: "engine.status", info: { ...event.info, claudePath: null, apiPort: null } };
  }
}
