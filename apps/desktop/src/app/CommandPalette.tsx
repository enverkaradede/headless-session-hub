/** The `/` menu under a prompt field: Claude's commands plus the skills of this and connected devices. */
import type { CatalogCommand } from "@hub/protocol";
import { CircleAlert, LoaderCircle, Slash } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from "react";
import { applyCommand, commandQuery, mergeCatalogs, rankEntries, type CatalogSource, type PaletteEntry } from "../lib/commands";
import { HubError, rpc } from "../lib/ipc";

/** The engine caches for 5 minutes; this only avoids refetching while the owner types. */
const UI_CACHE_MS = 60_000;

type SourceState = { status: "loading" } | { status: "ready"; commands: CatalogCommand[] } | { status: "error"; message: string };

const cache = new Map<string, { at: number; commands: CatalogCommand[] }>();
const sourceKey = (source: CatalogSource) => `${source.device}\u0000${source.profileId}\u0000${source.cwd ?? ""}`;

async function fetchCatalog(source: CatalogSource): Promise<CatalogCommand[]> {
  const key = sourceKey(source);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < UI_CACHE_MS) return hit.commands;
  let commands: CatalogCommand[];
  try {
    commands = (await rpc(source.device, "catalog.list", { profileId: source.profileId, ...(source.cwd ? { cwd: source.cwd } : {}) })).commands;
  } catch (err) {
    // A folder outside the allowlist still gets the profile's own skills, just not the project's.
    if (!(err instanceof HubError && err.code === "DIRECTORY_NOT_ALLOWED" && source.cwd)) throw err;
    commands = (await rpc(source.device, "catalog.list", { profileId: source.profileId })).commands;
  }
  cache.set(key, { at: Date.now(), commands });
  return commands;
}

/** Loads every source once `enabled` turns true (the menu opened); later source changes load the new ones. */
function useCatalogs(sources: readonly CatalogSource[], enabled: boolean): Map<string, SourceState> {
  const [states, setStates] = useState<Map<string, SourceState>>(new Map());
  const keys = sources.map(sourceKey).join("|");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const update = (key: string, state: SourceState) => {
      if (!cancelled) setStates((current) => new Map(current).set(key, state));
    };
    for (const source of sources) {
      const key = sourceKey(source);
      update(key, { status: "loading" });
      fetchCatalog(source)
        .then((commands) => update(key, { status: "ready", commands }))
        .catch((err: unknown) => update(key, { status: "error", message: err instanceof Error ? err.message : "Okunamadı" }));
    }
    return () => {
      cancelled = true;
    };
    // `keys` captures the sources' identity; the array itself is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, enabled]);
  return states;
}

export interface CommandPaletteController {
  open: boolean;
  entries: PaletteEntry[];
  active: number;
  setActive: (index: number) => void;
  pending: CatalogSource[];
  failed: { source: CatalogSource; message: string }[];
  pick: (entry: PaletteEntry) => void;
  /** Call first in the field's onKeyDown; true means the key belonged to the menu. */
  handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  trackCaret: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
}

export function useCommandPalette(options: {
  text: string;
  setText: (next: string) => void;
  field: RefObject<HTMLTextAreaElement | null>;
  sources: readonly CatalogSource[];
  onPick?: (entry: PaletteEntry) => void;
}): CommandPaletteController {
  const { text, setText, field, sources, onPick } = options;
  const [caret, setCaret] = useState(text.length);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [everOpened, setEverOpened] = useState(false);
  const [active, setActive] = useState(0);
  const query = commandQuery(text, caret);
  const open = query !== null && dismissedAt !== text && sources.length > 0;
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);
  const states = useCatalogs(sources, everOpened);

  const entries = useMemo(() => {
    if (!open || query === null) return [];
    const ready = sources.flatMap((source) => {
      const state = states.get(sourceKey(source));
      return state?.status === "ready" ? [{ source, commands: state.commands }] : [];
    });
    return rankEntries(mergeCatalogs(ready), query);
  }, [open, query, sources, states]);
  useEffect(() => setActive(0), [query]);

  const pending = sources.filter((source) => states.get(sourceKey(source))?.status !== "ready" && states.get(sourceKey(source))?.status !== "error");
  const failed = sources.flatMap((source) => {
    const state = states.get(sourceKey(source));
    return state?.status === "error" ? [{ source, message: state.message }] : [];
  });

  const pick = (entry: PaletteEntry) => {
    const next = applyCommand(text, entry.name);
    setText(next.text);
    setCaret(next.caret);
    onPick?.(entry);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    const move = (delta: number) => {
      event.preventDefault();
      if (entries.length > 0) setActive((current) => (current + delta + entries.length) % entries.length);
    };
    switch (event.key) {
      case "ArrowDown":
        move(1);
        return true;
      case "ArrowUp":
        move(-1);
        return true;
      case "Enter":
      case "Tab": {
        const entry = entries[active];
        if (!entry || event.shiftKey) return false;
        event.preventDefault();
        pick(entry);
        return true;
      }
      case "Escape":
        // preventDefault tells the screen-level Esc handler that this Esc only closed the menu.
        event.preventDefault();
        setDismissedAt(text);
        return true;
      default:
        return false;
    }
  };

  const trackCaret = (event: SyntheticEvent<HTMLTextAreaElement>) => setCaret(event.currentTarget.selectionStart);

  return { open, entries, active, setActive, pending, failed, pick, handleKey, trackCaret };
}

function ownerLabel(entry: PaletteEntry, showProfile: boolean): string {
  if (!entry.owner) return "Claude";
  return showProfile ? `${entry.owner.deviceLabel} · ${entry.owner.profileLabel}` : entry.owner.deviceLabel;
}

/** The floating list. Rows show the owning device on the right; picking a skill pins the session to it. */
export function CommandPalette({ controller, placement, showProfile, footnote }: { controller: CommandPaletteController; placement: "above" | "below"; showProfile: boolean; footnote?: string }) {
  const { open, entries, active, setActive, pending, failed, pick } = controller;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const offset = placement === "below" ? 6 : -6;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: offset, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: offset, scale: 0.985 }}
          transition={{ type: "spring", stiffness: 520, damping: 36 }}
          className={`absolute inset-x-0 z-30 overflow-hidden rounded-xl border border-white/[0.08] bg-harbor-900/95 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_24px_48px_-20px_rgba(0,0,0,0.85)] backdrop-blur-2xl ${placement === "below" ? "top-full mt-2" : "bottom-full mb-2"}`}
          role="listbox"
          aria-label="Komutlar ve skill'ler"
        >
          <div ref={list} className="scroll-quiet max-h-[320px] overflow-y-auto p-1.5">
            {entries.map((entry, index) => (
              <div
                key={entry.key}
                data-index={index}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault(); // keep focus in the field
                  pick(entry);
                }}
                className="relative flex cursor-default items-center gap-3 rounded-lg px-3 py-2"
              >
                {index === active && (
                  <motion.span layoutId="palette-active" className="absolute inset-0 rounded-lg bg-beacon-400/[0.09] ring-1 ring-beacon-400/20" transition={{ type: "spring", stiffness: 600, damping: 40 }} />
                )}
                <div className="relative min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className={`font-mono text-[13px] ${entry.builtin ? "text-ink-200" : "text-beacon-300"}`}>/{entry.name}</span>
                    {entry.argumentHint && <span className="truncate font-mono text-[11.5px] text-ink-500">{entry.argumentHint}</span>}
                  </div>
                  {entry.description && <div className="truncate text-[12px] text-ink-400">{entry.description}</div>}
                </div>
                <span
                  className={`relative shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${entry.owner ? "border-beacon-400/25 bg-beacon-400/[0.08] text-beacon-200" : "border-white/10 bg-white/[0.04] text-ink-400"}`}
                >
                  {ownerLabel(entry, showProfile)}
                </span>
              </div>
            ))}
            {entries.length === 0 && pending.length === 0 && (
              <div className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-ink-400">
                <Slash className="size-3.5" /> Eşleşen komut ya da skill yok.
              </div>
            )}
            {pending.map((source) => (
              <div key={`pending-${source.device}-${source.profileId}`} className="flex items-center gap-2 px-3 py-2 text-[12px] text-ink-400">
                <LoaderCircle className="size-3.5 animate-spin" />
                {source.deviceLabel}
                {showProfile ? ` · ${source.profileLabel}` : ""} komutları okunuyor…
              </div>
            ))}
            {failed.map(({ source, message }) => (
              <div key={`failed-${source.device}-${source.profileId}`} className="flex items-center gap-2 px-3 py-2 text-[12px] text-rose-glow/80">
                <CircleAlert className="size-3.5 shrink-0" />
                <span className="truncate">
                  {source.deviceLabel}
                  {showProfile ? ` · ${source.profileLabel}` : ""}: {message}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 border-t border-white/[0.05] px-3 py-1.5 text-[11px] text-ink-500">
            <span>↑↓ gez</span>
            <span>Enter / Tab seç</span>
            <span>Esc kapat</span>
            {footnote && <span className="ml-auto">{footnote}</span>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
