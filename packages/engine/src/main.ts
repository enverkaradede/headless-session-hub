/**
 * Engine entry point. Spawned by the desktop shell as a sidecar:
 *   node engine.mjs --data-dir <dir> [--hubctl <path>]
 * stdout carries JSON lines (EngineOutbound), stdin carries RPC requests, stderr carries logs.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { PROTOCOL_VERSION, RpcRequestEnvelope, type AuthState, type ClaudeProfile, type EngineInfo, type EngineOutbound } from "@hub/protocol";
import { LocalApi } from "./api/http.ts";
import { apiKeySourceIsNonSubscription, authAllowsStart, buildChildEnv, claudeVersion, readAuthState, resolveClaudeExecutable } from "./claude.ts";
import { systemClock } from "./clock.ts";
import { Store } from "./db.ts";
import { EngineError } from "./errors.ts";
import { EventBus, type LifecycleSink } from "./events.ts";
import { CompatLayer } from "./hooks/compat.ts";
import { log } from "./log.ts";
import { peerEvent, RpcDispatcher } from "./rpc.ts";
import { SessionManager, type ClaudeHost } from "./sessions/manager.ts";
import { SettingsService } from "./settings.ts";
import { WebhookDispatcher } from "./webhooks.ts";

const ENGINE_VERSION = "0.1.0";
const AUTH_CACHE_MS = 60_000;
const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DISCOVERY_FILE = "engine.json";

function writeLine(message: EngineOutbound | { t: "pevt"; event: unknown }): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Real ClaudeHost: caches the executable path and per-profile auth for a minute. */
class CliClaudeHost implements ClaudeHost {
  private exe: { path: string | null; at: number } | null = null;
  private readonly authCache = new Map<string, AuthState>();

  constructor(private readonly settings: SettingsService) {}

  async executable(): Promise<string | null> {
    const now = Date.now();
    if (this.exe && now - this.exe.at < AUTH_CACHE_MS) return this.exe.path;
    const resolved = await resolveClaudeExecutable(this.settings.get().claudePath);
    this.exe = { path: resolved, at: now };
    return resolved;
  }

  /** Runs `claude auth status` before every session start, as required; cached only for UI display. */
  async auth(profile: ClaudeProfile): Promise<AuthState> {
    const exe = await this.executable();
    if (!exe) return { profileId: profile.id, method: "unknown", detail: "Claude Code not found", checkedAt: Date.now() };
    const state = await readAuthState(exe, profile, this.settings.get().allowNonSubscriptionAuth, Date.now());
    this.authCache.set(profile.id, state);
    return state;
  }

  cachedAuth(): AuthState[] {
    return [...this.authCache.values()];
  }

  invalidate(): void {
    this.exe = null;
  }

  childEnv(profile: ClaudeProfile, extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
    return buildChildEnv({ profile, allowNonSubscriptionAuth: this.settings.get().allowNonSubscriptionAuth, ...(extra ? { extra } : {}) });
  }

  allowsStart(auth: AuthState): boolean {
    return authAllowsStart(auth, this.settings.get().allowNonSubscriptionAuth);
  }

  isNonSubscriptionKeySource(apiKeySource: string): boolean {
    return apiKeySourceIsNonSubscription(apiKeySource);
  }
}

/** Writes the API port and token for hubctl. The token file is owner-only. */
async function writeDiscovery(dataDir: string, port: number, token: string): Promise<void> {
  const file = path.join(dataDir, DISCOVERY_FILE);
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify({ port, token, pid: process.pid, protocolVersion: PROTOCOL_VERSION }), { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined); // no-op on Windows, where %APPDATA% is already per-user
  await rename(temp, file);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" }, hubctl: { type: "string" }, "api-port": { type: "string" } } });
  const dataDir = values["data-dir"];
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("--data-dir <absolute path> is required");
  await mkdir(dataDir, { recursive: true });

  const store = new Store(path.join(dataDir, "engine.sqlite"));
  const settings = new SettingsService(store);
  const bus = new EventBus();
  const claude = new CliClaudeHost(settings);
  const webhooks = new WebhookDispatcher(() => settings.get());
  const lifecycle: LifecycleSink = {
    lifecycle(event, session, lastMessage) {
      webhooks.lifecycle(event, session, lastMessage);
      if (event === "session.completed") bus.emit({ type: "notify", title: `${session.name} finished`, body: lastMessage?.slice(0, 200) ?? "Done", sessionId: session.id });
      if (event === "session.error") bus.emit({ type: "notify", title: `${session.name} failed`, body: lastMessage?.slice(0, 200) ?? "Error", sessionId: session.id });
    },
  };
  const manager = new SessionManager({ store, bus, clock: systemClock, queryFn: query, claude, lifecycle, settings: () => settings.get() });
  manager.recover();

  const hubctlPath = values.hubctl ?? null;
  let apiPort: number | null = null;
  let version: string | null = null;
  let exePath: string | null = null;
  const info = (): EngineInfo => ({
    protocolVersion: PROTOCOL_VERSION,
    engineVersion: ENGINE_VERSION,
    hostname: hostname(),
    platform: platform(),
    claudePath: exePath,
    claudeVersion: version,
    auth: claude.cachedAuth(),
    apiPort,
  });
  const refreshAuth = async (): Promise<AuthState[]> => {
    claude.invalidate();
    exePath = await claude.executable();
    version = exePath ? await claudeVersion(exePath) : null;
    const states = await Promise.all(settings.get().profiles.map((profile) => claude.auth(profile)));
    bus.emit({ type: "engine.status", info: info() });
    return states;
  };

  const rpc = new RpcDispatcher({ manager, settings, info, refreshAuth, hubctlPath });
  const compat = new CompatLayer(manager, systemClock, () => settings.get());
  const token = randomBytes(32).toString("hex");
  const api = new LocalApi(token, rpc, compat);
  apiPort = await api.listen(values["api-port"] ? Number(values["api-port"]) : 0);
  await writeDiscovery(dataDir, apiPort, token);

  bus.on((event) => {
    writeLine({ t: "evt", event });
    const forPeers = peerEvent(event, settings.get().summaryOnlyForPeers);
    if (forPeers) writeLine({ t: "pevt", event: forPeers });
  });

  const sweep = () => {
    const cutoff = Date.now() - settings.get().eventRetentionDays * DAY_MS;
    const removed = store.purgeEventsBefore(cutoff);
    if (removed > 0) log.info("retention sweep", { removed });
  };
  sweep();
  setInterval(sweep, RETENTION_SWEEP_MS).unref();

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => void handleLine(line, rpc));
  lines.on("close", () => void shutdown(api, store, "stdin closed"));
  process.on("SIGTERM", () => void shutdown(api, store, "SIGTERM"));
  process.on("SIGINT", () => void shutdown(api, store, "SIGINT"));

  writeLine({ t: "ready", info: info() });
  log.info("engine ready", { apiPort, dataDir });
  void refreshAuth().catch((err: unknown) => log.warn("initial auth refresh failed", { err }));
}

async function handleLine(line: string, rpc: RpcDispatcher): Promise<void> {
  if (!line.trim()) return;
  let id = "unknown";
  try {
    const envelope = RpcRequestEnvelope.parse(JSON.parse(line));
    id = envelope.id;
    const result = await rpc.dispatch(envelope.method, envelope.params, envelope.caller);
    writeLine({ t: "res", id, ok: true, result });
  } catch (err) {
    const engineError = err instanceof EngineError ? err : null;
    if (!engineError) log.error("rpc failed", { err, id });
    writeLine({ t: "res", id, ok: false, error: { code: engineError?.code ?? "INTERNAL", message: engineError?.message ?? "Internal error" } });
  }
}

let shuttingDown = false;
async function shutdown(api: LocalApi, store: Store, reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("engine shutting down", { reason });
  await api.close();
  store.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  log.error("engine failed to start", { err });
  process.exit(1);
});
