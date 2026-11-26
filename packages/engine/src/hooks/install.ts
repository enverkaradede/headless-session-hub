/** Installs/removes the hub's Claude Code hooks in a profile's settings.json without disturbing other entries. */
import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ClaudeProfile } from "@hub/protocol";
import { expandHome } from "../claude.ts";
import { EngineError } from "../errors.ts";

export const HOOK_EVENTS = ["SessionStart", "SessionEnd", "Stop", "Notification", "PermissionRequest"] as const;
/** Claude Code's default for command hooks; the hub answers just before it (see PERMISSION_HOOK_BUDGET_MS). */
const PERMISSION_HOOK_TIMEOUT_SECONDS = 600;
const STATUS_HOOK_TIMEOUT_SECONDS = 10;
const BACKUP_SUFFIX = ".session-hub.bak";

interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
}
interface HookMatcher {
  matcher?: string;
  hooks?: HookCommand[];
}
type SettingsJson = Record<string, unknown> & { hooks?: Record<string, HookMatcher[]> };

export function settingsPathFor(profile: ClaudeProfile): string {
  const root = profile.configDir ? expandHome(profile.configDir) : path.join(homedir(), ".claude");
  return path.join(root, "settings.json");
}

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Single-quoted for POSIX shells: nothing inside is expanded, and a quote in the path is escaped as '\''. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The hook runs hubctl only while it exists, so moving or uninstalling the app never breaks a Claude session
 * ("hook failed: No such file or directory" on every start). Claude Code runs hook commands in bash: $SHELL on
 * macOS/Linux and Git Bash on Windows. Forward slashes keep Windows paths valid there.
 */
export function hookCommand(hubctlPath: string, event: string, platform: NodeJS.Platform = process.platform): string {
  const quoted = shellQuote(platform === "win32" ? hubctlPath.replaceAll("\\", "/") : hubctlPath);
  return `if [ -f ${quoted} ]; then ${quoted} hook ${event}; fi`;
}

const EVENT_PATTERN = `(${HOOK_EVENTS.join("|")})`;
/** 0.1.x wrote `"<path>" hook <Event>`, which fails the hook when the path is gone. */
const LEGACY_HOOK_RE = new RegExp(`^"([^"]*hubctl(?:\\.exe)?)" hook ${EVENT_PATTERN}$`);
const GUARDED_HOOK_RE = new RegExp(`^if \\[ -f '((?:[^']|'\\\\'')*hubctl(?:\\.exe)?)' \\]; then '\\1' hook ${EVENT_PATTERN}; fi$`);

/** A hub hook found in a settings file: which hubctl it runs and whether it is the old, unguarded form. */
export interface HubHook {
  hubctlPath: string;
  event: HookEvent;
  legacy: boolean;
}

export function parseHubHook(command: string): HubHook | null {
  const guarded = GUARDED_HOOK_RE.exec(command);
  if (guarded?.[1] && guarded[2]) return { hubctlPath: guarded[1].replaceAll("'\\''", "'"), event: guarded[2] as HookEvent, legacy: false };
  const legacy = LEGACY_HOOK_RE.exec(command);
  if (legacy?.[1] && legacy[2]) return { hubctlPath: legacy[1], event: legacy[2] as HookEvent, legacy: true };
  return null;
}

function isHubHook(hook: HookCommand): boolean {
  return typeof hook.command === "string" && parseHubHook(hook.command) !== null;
}

async function readSettings(file: string): Promise<SettingsJson> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as SettingsJson;
  } catch (err) {
    // Never overwrite a file we cannot parse: it is the user's configuration.
    throw new EngineError("CONFLICT", `${file} is not valid JSON; fix it before installing hooks.`, { cause: err });
  }
}

async function backupOnce(file: string): Promise<void> {
  try {
    await access(`${file}${BACKUP_SUFFIX}`);
    return;
  } catch {
    // no backup yet
  }
  try {
    await copyFile(file, `${file}${BACKUP_SUFFIX}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function writeAtomically(file: string, settings: SettingsJson): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await backupOnce(file);
  const temp = `${file}.session-hub.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function withoutHubHooks(settings: SettingsJson): SettingsJson {
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    const kept = (Array.isArray(matchers) ? matchers : [])
      .map((matcher) => ({ ...matcher, hooks: (matcher.hooks ?? []).filter((hook) => !isHubHook(hook)) }))
      .filter((matcher) => matcher.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _previous, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

function hubHooksIn(settings: SettingsJson): HubHook[] {
  return Object.values(settings.hooks ?? {})
    .flatMap((matchers) => (Array.isArray(matchers) ? matchers : []))
    .flatMap((matcher) => matcher.hooks ?? [])
    .flatMap((hook) => (typeof hook.command === "string" ? (parseHubHook(hook.command) ?? []) : []));
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** ok: every event runs an existing hubctl. broken: some hook is missing or points at a hubctl that is gone. */
export type HookHealth = "not_installed" | "ok" | "broken";

export interface HooksReport {
  installed: boolean;
  health: HookHealth;
  hooks: HubHook[];
  /** Some hook runs a hubctl path where no file exists. */
  hubctlMissing: boolean;
}

export async function inspectHooks(profile: ClaudeProfile): Promise<HooksReport> {
  let settings: SettingsJson;
  try {
    settings = await readSettings(settingsPathFor(profile));
  } catch {
    return { installed: false, health: "not_installed", hooks: [], hubctlMissing: false };
  }
  const hooks = hubHooksIn(settings);
  const installed = HOOK_EVENTS.every((event) => hooks.some((hook) => hook.event === event));
  if (hooks.length === 0) return { installed, health: "not_installed", hooks, hubctlMissing: false };
  const hubctlMissing = (await Promise.all(hooks.map((hook) => isFile(hook.hubctlPath)))).includes(false);
  return { installed, health: installed && !hubctlMissing ? "ok" : "broken", hooks, hubctlMissing };
}

export async function hooksInstalled(profile: ClaudeProfile): Promise<boolean> {
  return (await inspectHooks(profile)).installed;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return left === right;
  const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * Re-points the hub's hooks at this install's hubctl when they are broken (app moved, reinstalled elsewhere,
 * hubctl removed) or still in the unguarded 0.1.x form. Hooks that run another install's existing hubctl
 * (a dev build next to the release) are left alone; that install heals its own.
 */
export async function healHooks(profile: ClaudeProfile, hubctlPath: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const report = await inspectHooks(profile);
  if (report.hooks.length === 0) return false;
  const needsRepair =
    !report.installed ||
    report.hubctlMissing ||
    report.hooks.some((hook) => hook.legacy && samePath(hook.hubctlPath, hubctlPath, platform));
  if (!needsRepair) return false;
  await installHooks(profile, hubctlPath);
  return true;
}

export async function installHooks(profile: ClaudeProfile, hubctlPath: string): Promise<void> {
  const file = settingsPathFor(profile);
  const settings = withoutHubHooks(await readSettings(file));
  const hooks = { ...(settings.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const timeout = event === "PermissionRequest" ? PERMISSION_HOOK_TIMEOUT_SECONDS : STATUS_HOOK_TIMEOUT_SECONDS;
    const entry: HookMatcher = { hooks: [{ type: "command", command: hookCommand(hubctlPath, event), timeout }] };
    if (event === "PermissionRequest") entry.matcher = "*";
    hooks[event] = [...(hooks[event] ?? []), entry];
  }
  await writeAtomically(file, { ...settings, hooks });
}

export async function uninstallHooks(profile: ClaudeProfile): Promise<void> {
  const file = settingsPathFor(profile);
  await writeAtomically(file, withoutHubHooks(await readSettings(file)));
}
