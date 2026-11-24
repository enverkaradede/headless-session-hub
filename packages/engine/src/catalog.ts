/**
 * The `/` menu: slash commands and skills a Claude profile offers in a folder. Read from a Claude process that is
 * started without a prompt and closed again, so it costs no tokens and matches exactly what a session would load.
 */
import { mkdir } from "node:fs/promises";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Catalog, CatalogCommand, CatalogParams, ClaudeProfile, EngineSettings } from "@hub/protocol";
import type { Clock } from "./clock.ts";
import { EngineError } from "./errors.ts";
import { log } from "./log.ts";
import { assertAllowedDirectory } from "./paths.ts";
import type { QueryFn } from "./sessions/manager.ts";

const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 32;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_DESCRIPTION_CHARS = 300;
/** Commands the CLI keeps for its own plumbing; never meant to be typed. */
const INTERNAL_PREFIX = "__";

export interface CatalogDeps {
  queryFn: QueryFn;
  clock: Clock;
  settings: () => EngineSettings;
  executable: () => Promise<string | null>;
  childEnv: (profile: ClaudeProfile) => NodeJS.ProcessEnv;
  /** An empty folder owned by the hub: the probe's cwd when no project is chosen, so no project settings load. */
  neutralDir: string;
}

/** An input stream that never sends a message; ends when `close` is called. */
function silentInput(): { stream: AsyncIterable<never>; close: () => void } {
  let close: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (close = resolve));
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        await closed;
      },
    },
    close: () => close(),
  };
}

export function toCatalogCommands(commands: ReadonlyArray<{ name: string; description: string; argumentHint?: string; builtin?: boolean }>): CatalogCommand[] {
  const seen = new Set<string>();
  const result: CatalogCommand[] = [];
  for (const command of commands) {
    if (!command.name || command.name.startsWith(INTERNAL_PREFIX)) continue;
    const key = `${command.builtin ? "b" : "c"}:${command.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const description = command.description.length > MAX_DESCRIPTION_CHARS ? `${command.description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : command.description;
    result.push({ name: command.name, description, argumentHint: command.argumentHint ?? "", builtin: command.builtin === true });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export class CatalogService {
  private readonly cache = new Map<string, Catalog>();
  private readonly inflight = new Map<string, Promise<Catalog>>();

  constructor(private readonly deps: CatalogDeps) {}

  async list(params: CatalogParams): Promise<Catalog> {
    const settings = this.deps.settings();
    const profileId = params.profileId ?? settings.defaultProfileId;
    const profile = settings.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new EngineError("NOT_FOUND", `Unknown profile ${profileId}`);
    // Starting Claude in a folder loads that folder's settings and hooks: the same allowlist as a session applies.
    const cwd = params.cwd ? await assertAllowedDirectory(params.cwd, settings.allowedDirectories) : null;
    const key = `${profile.id}\u0000${cwd ?? ""}`;
    const cached = this.cache.get(key);
    if (cached && !params.refresh && this.deps.clock.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
    const running = this.inflight.get(key);
    if (running) return running;
    const probe = this.probe(profile, cwd)
      .then((catalog) => {
        this.remember(key, catalog);
        return catalog;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, probe);
    return probe;
  }

  private remember(key: string, catalog: Catalog): void {
    this.cache.delete(key);
    this.cache.set(key, catalog);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async probe(profile: ClaudeProfile, cwd: string | null): Promise<Catalog> {
    const executable = await this.deps.executable();
    if (!executable) throw new EngineError("CLAUDE_NOT_FOUND", "Claude Code was not found. Install it or set its path in Settings.");
    if (!cwd) await mkdir(this.deps.neutralDir, { recursive: true });
    const input = silentInput();
    const abort = new AbortController();
    let query: Query | null = null;
    let timer: { cancel(): void } | null = null;
    try {
      query = this.deps.queryFn({
        prompt: input.stream,
        options: {
          cwd: cwd ?? this.deps.neutralDir,
          pathToClaudeCodeExecutable: executable,
          env: this.deps.childEnv(profile),
          abortController: abort,
          settingSources: ["user", "project", "local"],
          persistSession: false,
          stderr: (data) => log.debug("catalog probe stderr", { data: data.slice(0, 500) }),
        },
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = this.deps.clock.setTimeout(() => reject(new EngineError("INTERNAL", "Claude did not report its commands in time")), PROBE_TIMEOUT_MS);
      });
      const init = await Promise.race([query.initializationResult(), timeout]);
      return { profileId: profile.id, cwd, commands: toCatalogCommands(init.commands), fetchedAt: this.deps.clock.now() };
    } catch (err) {
      log.warn("catalog probe failed", { profileId: profile.id, cwd, err });
      throw err instanceof EngineError ? err : new EngineError("INTERNAL", `Could not read the command list: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      (timer as { cancel(): void } | null)?.cancel();
      input.close();
      abort.abort();
    }
  }
}
