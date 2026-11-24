/** Working-directory allowlist: sessions may only start inside directories the owner approved. */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { EngineError } from "./errors.ts";

/** True when `child` is `parent` or inside it. Case-insensitive on Windows. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const impl = platform === "win32" ? path.win32 : path.posix;
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const relative = impl.relative(fold(impl.resolve(parent)), fold(impl.resolve(child)));
  return relative === "" || (!relative.startsWith("..") && !impl.isAbsolute(relative));
}

/** Resolves symlinks and `..`; rejects relative paths and non-directories. */
export async function canonicalDirectory(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new EngineError("BAD_REQUEST", "cwd must be an absolute path");
  let resolved: string;
  try {
    resolved = await realpath(input);
  } catch (err) {
    throw new EngineError("BAD_REQUEST", "cwd does not exist", { cause: err });
  }
  if (!(await stat(resolved)).isDirectory()) throw new EngineError("BAD_REQUEST", "cwd is not a directory");
  return resolved;
}

/** Returns the canonical cwd if it sits inside an allowlisted directory, otherwise throws DIRECTORY_NOT_ALLOWED. */
export async function assertAllowedDirectory(cwd: string, allowlist: readonly string[]): Promise<string> {
  const canonical = await canonicalDirectory(cwd);
  for (const entry of allowlist) {
    let root: string;
    try {
      root = await realpath(entry);
    } catch {
      continue; // An allowlisted directory that no longer exists grants nothing.
    }
    if (isInside(canonical, root)) return canonical;
  }
  throw new EngineError("DIRECTORY_NOT_ALLOWED", "This directory is not in the allowed directories list. Add it in Settings first.");
}
