/** Installs/removes the hub's Claude Code hooks in a profile's settings.json without disturbing other entries. */
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/** Forward slashes work in Git Bash, cmd and PowerShell alike, and survive double-quoting. */
export function hookCommand(hubctlPath: string, event: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === "win32" ? hubctlPath.replaceAll("\\", "/") : hubctlPath;
  return `"${normalized}" hook ${event}`;
}

const HUB_HOOK_RE = /hubctl(?:\.exe)?" hook (?:SessionStart|SessionEnd|Stop|Notification|PermissionRequest)$/;

function isHubHook(hook: HookCommand): boolean {
  return typeof hook.command === "string" && HUB_HOOK_RE.test(hook.command);
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

export async function hooksInstalled(profile: ClaudeProfile): Promise<boolean> {
  let settings: SettingsJson;
  try {
    settings = await readSettings(settingsPathFor(profile));
  } catch {
    return false;
  }
  return HOOK_EVENTS.every((event) => (settings.hooks?.[event] ?? []).some((matcher) => (matcher.hooks ?? []).some(isHubHook)));
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
