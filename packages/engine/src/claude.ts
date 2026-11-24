/** Locating the Claude Code CLI, reading its auth state per profile, and building a safe child environment. */
import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AUTH_ENV_VARS, type AuthState, type ClaudeProfile } from "@hub/protocol";
import { log } from "./log.ts";

const CLI_TIMEOUT_MS = 20_000;
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
const SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);
/** Set by Claude Code inside its own sessions; a nested CLI would treat itself as a child of ours. */
const NESTING_ENV_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];
/**
 * Set on every Claude process the hub starts itself. `hubctl hook` ignores such processes: the hub already drives
 * them through the SDK, and globally installed hooks would otherwise list them a second time as claude -p sessions.
 */
export const MANAGED_SESSION_ENV = "HUB_MANAGED_SESSION";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI with an argv array (never a shell) and decodes output explicitly as UTF-8. */
export function runCli(exe: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      [...args],
      { env, encoding: "buffer", timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_CLI_OUTPUT_BYTES, windowsHide: true },
      (err, stdout, stderr) => {
        const decode = (buffer: Buffer) => new TextDecoder("utf-8").decode(buffer);
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
          reject(err);
          return;
        }
        const exitCode = err ? Number((err as { code?: number }).code ?? 1) : 0;
        resolve({ exitCode, stdout: decode(stdout), stderr: decode(stderr) });
      },
    );
  });
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) return false;
    if (process.platform !== "win32") await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the real Claude Code executable. On Windows npm-style `.cmd`/`.ps1` shims are skipped:
 * they need a shell to run and mangle non-ASCII arguments.
 */
export async function resolveClaudeExecutable(configured: string | null): Promise<string | null> {
  if (configured) {
    if (SHIM_EXTENSIONS.has(path.extname(configured).toLowerCase())) {
      log.warn("configured claude path is a script shim; ignoring it", { configured });
    } else if (await isExecutableFile(configured)) {
      return configured;
    } else {
      log.warn("configured claude path is not an executable file", { configured });
    }
  }
  const exeName = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [path.join(homedir(), ".local", "bin", exeName)];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exeName));
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "claude", exeName));
  }
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export async function claudeVersion(exe: string): Promise<string | null> {
  try {
    const result = await runCli(exe, ["--version"], buildChildEnv({ profile: null, allowNonSubscriptionAuth: false }));
    return result.stdout.trim().split(/\s+/)[0] ?? null;
  } catch (err) {
    log.warn("claude --version failed", { err });
    return null;
  }
}

export interface ChildEnvOptions {
  profile: ClaudeProfile | null;
  allowNonSubscriptionAuth: boolean;
  extra?: Record<string, string>;
  base?: NodeJS.ProcessEnv;
}

/**
 * The environment every Claude child process gets. Provider and API-key variables are removed
 * unless the owner explicitly allowed non-subscription auth, so a stray ANTHROPIC_API_KEY can
 * never silently move a session from the subscription to pay-as-you-go billing.
 */
export function buildChildEnv(options: ChildEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.base ?? process.env) };
  for (const name of NESTING_ENV_VARS) delete env[name];
  if (!options.allowNonSubscriptionAuth) {
    for (const name of Object.keys(env)) {
      if (AUTH_ENV_VARS.includes(name.toUpperCase())) delete env[name];
    }
  }
  delete env.CLAUDE_CONFIG_DIR;
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (AUTH_ENV_VARS.includes(name.toUpperCase())) continue;
    env[name] = value;
  }
  if (options.profile?.configDir) env.CLAUDE_CONFIG_DIR = expandHome(options.profile.configDir);
  env[MANAGED_SESSION_ENV] = "1";
  return env;
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2));
  return value;
}

const SUBSCRIPTION_METHODS = new Set(["claude.ai", "oauth_token"]);
const API_KEY_METHODS = new Set(["api_key", "api_key_helper"]);

/** Maps `claude auth status` JSON to our coarse auth state. Reads only the method and plan, never identity fields. */
export function classifyAuth(profileId: string, exitCode: number, stdout: string, now: number): AuthState {
  type AuthJson = { authMethod?: unknown; subscriptionType?: unknown; loggedIn?: unknown };
  const parseAuth = (): AuthJson | null => {
    try {
      const value: unknown = JSON.parse(stdout);
      return value !== null && typeof value === "object" ? (value as AuthJson) : null;
    } catch {
      return null;
    }
  };
  const parsed = parseAuth();
  const method = typeof parsed?.authMethod === "string" ? parsed.authMethod : null;
  const plan = typeof parsed?.subscriptionType === "string" ? parsed.subscriptionType : null;
  if (exitCode !== 0 || method === "none" || parsed?.loggedIn === false) {
    return { profileId, method: "not_logged_in", detail: "Not logged in. Run `claude` once and log in for this profile.", checkedAt: now };
  }
  if (method && SUBSCRIPTION_METHODS.has(method)) {
    return { profileId, method: "subscription", detail: plan ? `Subscription (${plan})` : "Subscription", checkedAt: now };
  }
  if (method && API_KEY_METHODS.has(method)) return { profileId, method: "api_key", detail: `API key (${method})`, checkedAt: now };
  if (method === "third_party") return { profileId, method: "third_party", detail: "Third-party provider (Bedrock/Vertex/Foundry)", checkedAt: now };
  return { profileId, method: "unknown", detail: method ? `Unrecognised auth method: ${method}` : "Could not read auth status", checkedAt: now };
}

export async function readAuthState(exe: string, profile: ClaudeProfile, allowNonSubscriptionAuth: boolean, now: number): Promise<AuthState> {
  try {
    const result = await runCli(exe, ["auth", "status"], buildChildEnv({ profile, allowNonSubscriptionAuth }));
    return classifyAuth(profile.id, result.exitCode, result.stdout, now);
  } catch (err) {
    log.warn("claude auth status failed", { err, profileId: profile.id });
    return { profileId: profile.id, method: "unknown", detail: "Could not run `claude auth status`", checkedAt: now };
  }
}

/** Whether a session may start under this auth state. */
export function authAllowsStart(auth: AuthState, allowNonSubscriptionAuth: boolean): boolean {
  if (auth.method === "subscription") return true;
  if (auth.method === "api_key" || auth.method === "third_party") return allowNonSubscriptionAuth;
  return false;
}

/** `init.apiKeySource` values that mean the session is NOT on the subscription login. */
export function apiKeySourceIsNonSubscription(apiKeySource: string): boolean {
  return apiKeySource !== "none" && apiKeySource !== "oauth";
}
