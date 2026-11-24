/** The `/` menu: which commands to show for a typed prefix, and how picking one rewrites the prompt. */
import type { CatalogCommand } from "@hub/protocol";

/** Where a catalog was read: one device + Claude profile (+ the project folder, when known). */
export interface CatalogSource {
  device: string;
  deviceLabel: string;
  profileId: string;
  profileLabel: string;
  cwd: string | null;
}

export interface PaletteEntry {
  key: string;
  name: string;
  description: string;
  argumentHint: string;
  builtin: boolean;
  /** The device and profile that own a skill; null for Claude's built-in commands, which exist everywhere. */
  owner: CatalogSource | null;
}

export const MAX_PALETTE_ROWS = 60;

/** The command token being typed at the start of the prompt (without "/"), or null when the menu should be closed. */
export function commandQuery(text: string, caret: number): string | null {
  const head = text.slice(0, caret);
  const match = /^\/(\S*)$/.exec(head);
  return match ? (match[1] ?? "") : null;
}

/** Replaces the leading command token with the picked command; keeps whatever follows it. */
export function applyCommand(text: string, name: string): { text: string; caret: number } {
  const tokenEnd = text.search(/\s/);
  const rest = tokenEnd === -1 ? "" : text.slice(tokenEnd).replace(/^[ \t]+/, "");
  const head = `/${name} `;
  return { text: head + rest, caret: head.length };
}

/** The command a prompt starts with, if any ("/review-pr 12" → "review-pr"). */
export function leadingCommand(text: string): string | null {
  const match = /^\/(\S+)/.exec(text);
  return match?.[1] ?? null;
}

/** One row per skill owner; built-ins once, since every device and profile has the same ones. */
export function mergeCatalogs(catalogs: ReadonlyArray<{ source: CatalogSource; commands: readonly CatalogCommand[] }>): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  const builtins = new Set<string>();
  for (const { source, commands } of catalogs) {
    for (const command of commands) {
      if (command.builtin) {
        if (builtins.has(command.name)) continue;
        builtins.add(command.name);
        entries.push({ key: `builtin:${command.name}`, ...command, owner: null });
      } else {
        entries.push({ key: `${source.device}:${source.profileId}:${command.name}`, ...command, owner: source });
      }
    }
  }
  return entries;
}

function matchRank(entry: PaletteEntry, query: string): number {
  if (query === "") return 0;
  const name = entry.name.toLowerCase();
  const bare = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
  if (name.startsWith(query) || bare.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (entry.description.toLowerCase().includes(query)) return 2;
  return -1;
}

/** Filters by the typed prefix; skills before built-ins, best match first, then by name and owner. */
export function rankEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.toLowerCase();
  return entries
    .map((entry) => ({ entry, rank: matchRank(entry, needle) }))
    .filter((item) => item.rank >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(a.entry.builtin) - Number(b.entry.builtin) ||
        a.entry.name.localeCompare(b.entry.name) ||
        (a.entry.owner?.deviceLabel ?? "").localeCompare(b.entry.owner?.deviceLabel ?? "") ||
        (a.entry.owner?.profileLabel ?? "").localeCompare(b.entry.owner?.profileLabel ?? ""),
    )
    .slice(0, MAX_PALETTE_ROWS)
    .map((item) => item.entry);
}
