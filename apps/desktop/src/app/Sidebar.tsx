/** Left panel: brand, new-session button, filters and the chat-style session list across devices. */
import type { SessionSummary } from "@hub/protocol";
import { Laptop, MessageSquareDashed, Plus, Search, Server, Settings2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { ATTENTION, STATUS_LABEL, STATUS_TONE, baseName, timeAgo } from "../lib/format";
import { LOCAL } from "../lib/ipc";
import { hub, useHub, type DeviceState } from "../lib/store";
import { Button, Segmented, StatusDot, type Tone } from "../ui/kit";
import { Brand } from "./Brand";
import { UpdatePill } from "./UpdateDialog";
import { useUpdater } from "../lib/updater";

type Filter = "all" | "waiting" | "active" | "finished";

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "Hepsi" },
  { value: "waiting", label: "Bekleyen" },
  { value: "active", label: "Aktif" },
  { value: "finished", label: "Biten" },
];

const ACTIVE = new Set(["starting", "running", "waiting_input", "waiting_permission", "idle"]);

function matchesFilter(session: SessionSummary, filter: Filter): boolean {
  if (filter === "waiting") return ATTENTION.has(session.status);
  if (filter === "active") return ACTIVE.has(session.status);
  if (filter === "finished") return !ACTIVE.has(session.status) && !ATTENTION.has(session.status);
  return true;
}

function matchesQuery(session: SessionSummary, query: string): boolean {
  if (!query) return true;
  const needle = query.toLocaleLowerCase("tr");
  return [session.name, session.cwd, ...session.labels].some((value) => value.toLocaleLowerCase("tr").includes(needle));
}

/** Attention first, then most recent activity. */
function sortSessions(a: SessionSummary, b: SessionSummary): number {
  const attention = Number(ATTENTION.has(b.status)) - Number(ATTENTION.has(a.status));
  return attention !== 0 ? attention : b.lastActivityAt - a.lastActivityAt;
}

export function Sidebar() {
  const devices = useHub((state) => state.devices);
  const view = useHub((state) => state.view);
  const engine = useHub((state) => state.engine);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    return Object.values(devices)
      .map((device) => ({
        device,
        sessions: Object.values(device.sessions).filter((session) => matchesFilter(session, filter) && matchesQuery(session, query)).sort(sortSessions),
      }))
      .sort((a, b) => (a.device.key === LOCAL ? -1 : b.device.key === LOCAL ? 1 : a.device.name.localeCompare(b.device.name, "tr")));
  }, [devices, filter, query]);

  const waitingCount = useMemo(
    () => Object.values(devices).reduce((total, device) => total + Object.values(device.sessions).filter((session) => ATTENTION.has(session.status)).length, 0),
    [devices],
  );
  const multiDevice = groups.length > 1;
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);

  return (
    <aside className="relative z-10 flex w-[312px] shrink-0 flex-col border-r border-white/[0.06] bg-harbor-900/60 backdrop-blur-2xl">
      <div data-tauri-drag-region className="h-[54px] shrink-0" />
      <Brand waiting={waitingCount} />
      <div className="mt-5 px-4">
        <Button variant="primary" size="lg" icon={Plus} className="w-full" onClick={() => hub.setView({ kind: "new" })}>
          Yeni oturum
        </Button>
      </div>
      <div className="mt-4 space-y-2.5 px-4">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-white/[0.07] bg-harbor-950/50 px-2.5 focus-within:border-beacon-400/50">
          <Search className="size-3.5 text-ink-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ara: ad, proje, etiket"
            spellCheck={false}
            className="h-full flex-1 bg-transparent text-[12.5px] text-ink-50 outline-none placeholder:text-ink-500"
          />
        </label>
        <Segmented value={filter} options={FILTERS} onChange={setFilter} size="sm" />
      </div>

      <div className="scroll-quiet mt-3 flex-1 overflow-y-auto px-2 pb-3">
        {total === 0 ? (
          <EmptyList filter={filter} hasQuery={query.length > 0} engineReady={engine.state === "ready"} />
        ) : (
          groups.map(({ device, sessions }) =>
            sessions.length === 0 && !multiDevice ? null : (
              <div key={device.key} className="mb-2">
                {multiDevice && <DeviceHeader device={device} count={sessions.length} />}
                <AnimatePresence initial={false}>
                  {sessions.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      device={device.key}
                      active={view.kind === "session" && view.device === device.key && view.sessionId === session.id}
                    />
                  ))}
                </AnimatePresence>
              </div>
            ),
          )
        )}
      </div>

      <div className="border-t border-white/[0.05] p-3">
        <UpdatePill />
        <button
          type="button"
          onClick={() => hub.setView({ kind: "settings" })}
          className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors ${
            view.kind === "settings" ? "bg-beacon-400/10 text-ink-50 ring-1 ring-beacon-400/25" : "text-ink-400 hover:bg-white/[0.04] hover:text-ink-50"
          }`}
        >
          <Settings2 className={`size-4 ${view.kind === "settings" ? "text-beacon-300" : ""}`} />
          Ayarlar
          <EngineIndicator />
        </button>
        <VersionSignature />
      </div>
    </aside>
  );
}

/** Bottom-left footer: app version with the author's signature under it. */
function VersionSignature() {
  const { currentVersion } = useUpdater();
  return (
    <div className="mt-2 px-3 leading-tight">
      <div className="font-mono text-[10.5px] text-ink-500 tabular-nums">Session Hub {currentVersion ? `v${currentVersion}` : ""}</div>
      <div className="mt-0.5 font-display text-[10.5px] tracking-wide text-ink-500/70">Enver Karadede</div>
    </div>
  );
}

function EngineIndicator() {
  const engine = useHub((state) => state.engine);
  const tone: Tone = engine.state === "ready" ? "ok" : engine.state === "starting" ? "busy" : "error";
  const label = engine.state === "ready" ? "Motor hazır" : engine.state === "starting" ? "Motor başlıyor" : "Motor yeniden başlıyor";
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-500" title={label}>
      <StatusDot tone={tone} size="sm" />
    </span>
  );
}

function DeviceHeader({ device, count }: { device: DeviceState; count: number }) {
  const Icon = device.key === LOCAL ? Laptop : Server;
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1.5 text-[11px] font-semibold tracking-wide text-ink-500 uppercase">
      <Icon className="size-3.5" />
      <span className="truncate">{device.key === LOCAL ? (device.info?.hostname ?? "Bu cihaz") : device.name}</span>
      {device.key !== LOCAL && <StatusDot tone={device.online ? "ok" : "idle"} size="sm" />}
      <span className="ml-auto font-mono tabular-nums">{count}</span>
    </div>
  );
}

function SessionItem({ session, device, active }: { session: SessionSummary; device: string; active: boolean }) {
  const waiting = ATTENTION.has(session.status);
  return (
    <motion.button
      layout
      type="button"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ type: "spring", stiffness: 500, damping: 38 }}
      onClick={() => hub.setView({ kind: "session", device, sessionId: session.id })}
      className={`relative mb-0.5 flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors ${active ? "" : "hover:bg-white/[0.035]"}`}
    >
      {active && (
        <motion.span
          layoutId="session-active"
          className="absolute inset-0 rounded-xl bg-gradient-to-r from-beacon-400/[0.14] to-beacon-400/[0.03] ring-1 ring-beacon-400/25"
          transition={{ type: "spring", stiffness: 500, damping: 38 }}
        />
      )}
      <div className="relative flex items-center gap-2">
        <StatusDot tone={STATUS_TONE[session.status]} />
        <span className={`min-w-0 flex-1 truncate text-[13.5px] ${waiting ? "font-semibold text-ink-50" : "font-medium text-ink-200"}`}>{session.name}</span>
        <span className="shrink-0 text-[11px] text-ink-500 tabular-nums">{timeAgo(session.lastActivityAt)}</span>
      </div>
      <div className="relative flex items-center gap-1.5 pl-4 text-[11.5px] text-ink-500">
        <span className={waiting ? "text-beacon-300" : ""}>{STATUS_LABEL[session.status]}</span>
        <span>·</span>
        <span className="truncate font-mono text-[11px]">{baseName(session.cwd)}</span>
        {session.origin === "hook" && <span className="shrink-0 rounded bg-white/[0.06] px-1 text-[10px] text-ink-400">-p</span>}
      </div>
      {session.lastMessagePreview && <p className="relative line-clamp-1 pl-4 text-[12px] text-ink-400">{session.lastMessagePreview}</p>}
    </motion.button>
  );
}

function EmptyList({ filter, hasQuery, engineReady }: { filter: Filter; hasQuery: boolean; engineReady: boolean }) {
  const text = hasQuery
    ? "Aramayla eşleşen oturum yok."
    : filter === "waiting"
      ? "Şu an seni bekleyen bir oturum yok."
      : !engineReady
        ? "Motor hazırlanıyor…"
        : "Henüz oturum yok. Yeni bir tane başlat ya da bir claude -p script'ini bağla.";
  return (
    <div className="flex flex-col items-center px-6 pt-10 text-center">
      <MessageSquareDashed className="size-5 text-ink-500" />
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-500">{text}</p>
    </div>
  );
}
