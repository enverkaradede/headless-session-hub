/** Subagent card inside a conversation, and the nested conversation pane it expands into. */
import type { TimelineEvent } from "@hub/protocol";
import { ArrowLeft, Bot, ChevronRight, CircleCheck, CircleX, Footprints, LoaderCircle, Maximize2, OctagonX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { formatTokens, timeAgo } from "../lib/format";
import { subagentPath, type SubagentInfo, type SubagentState } from "./subagents";
import { Timeline } from "./Timeline";

const SPRING = { type: "spring" as const, stiffness: 380, damping: 36, mass: 0.9 };

const STATE_STYLE: Record<SubagentState, { label: string; tone: string; icon: React.ReactNode }> = {
  running: { label: "Çalışıyor", tone: "text-harbor-300", icon: <LoaderCircle className="size-3.5 animate-spin" /> },
  completed: { label: "Tamamlandı", tone: "text-jade", icon: <CircleCheck className="size-3.5" /> },
  failed: { label: "Başarısız", tone: "text-rose-glow", icon: <CircleX className="size-3.5" /> },
  stopped: { label: "Durduruldu", tone: "text-ink-400", icon: <OctagonX className="size-3.5" /> },
};

function CardBody({ info }: { info: SubagentInfo }) {
  const state = STATE_STYLE[info.state];
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-violet-glow/10 text-violet-glow ring-1 ring-violet-glow/25">
          <Bot className="size-4" strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-violet-glow/30 bg-violet-glow/10 px-1.5 text-[11px] font-medium text-violet-glow">{info.type}</span>
            <span className="truncate text-[13.5px] font-medium text-ink-50">{info.description}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-500">
            <span className={`flex items-center gap-1 ${state.tone}`}>
              {state.icon}
              {state.label}
            </span>
            <span className="flex items-center gap-1">
              <Footprints className="size-3" /> {info.steps} adım
            </span>
            {info.totalTokens !== null && <span>{formatTokens(info.totalTokens)} token</span>}
          </div>
        </div>
        <Maximize2 className="size-3.5 shrink-0 text-ink-500 transition-colors group-hover:text-violet-glow" />
      </div>
      {(info.summary ?? info.lastActivity) && <p className="mt-2 line-clamp-2 pl-[42px] text-[12.5px] leading-relaxed text-ink-400">{info.summary ?? info.lastActivity}</p>}
    </>
  );
}

/** Collapsed subagent in the parent conversation. Shares its layoutId with the pane it opens. */
export function SubagentCard({ info, open, onOpen }: { info: SubagentInfo; open: boolean; onOpen: () => void }) {
  if (open) {
    // Keeps the slot's height while the real card is morphed into the pane.
    return (
      <div className="rounded-2xl border border-dashed border-violet-glow/25 p-3.5 opacity-40">
        <CardBody info={info} />
      </div>
    );
  }
  return (
    <motion.button
      type="button"
      layoutId={`subagent-${info.id}`}
      transition={SPRING}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.985 }}
      onClick={onOpen}
      className="group block w-full rounded-2xl border border-violet-glow/20 bg-gradient-to-b from-violet-glow/[0.07] to-harbor-850/70 p-3.5 text-left shadow-[0_10px_30px_-18px_rgba(167,139,250,0.55)] transition-colors hover:border-violet-glow/40"
    >
      <CardBody info={info} />
    </motion.button>
  );
}

/** The nested conversation of the top subagent on the stack, overlaid on the session content. */
export function SubagentPane({
  stack,
  index,
  events,
  onNavigate,
}: {
  stack: string[];
  index: Map<string, SubagentInfo>;
  events: readonly TimelineEvent[];
  onNavigate: (stack: string[]) => void;
}) {
  const currentId = stack[stack.length - 1];
  const info = currentId ? index.get(currentId) : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const ownEvents = events.filter((event) => event.parentToolUseId === currentId).length;

  useEffect(() => {
    if (!currentId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onNavigate(stack.slice(0, -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentId, stack, onNavigate]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [ownEvents, currentId]);

  return (
    <AnimatePresence>
      {info && (
        <>
          <motion.div
            key="scrim"
            className="absolute inset-0 z-20 bg-harbor-950/60 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => onNavigate([])}
          />
          <motion.section
            key={`pane-${info.id}`}
            layoutId={`subagent-${info.id}`}
            transition={SPRING}
            className="absolute inset-x-6 top-4 bottom-4 z-30 flex flex-col overflow-hidden rounded-3xl border border-violet-glow/25 bg-gradient-to-b from-harbor-850 to-harbor-900 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9),0_0_60px_-30px_rgba(167,139,250,0.6)]"
          >
            <motion.header initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.12 } }} className="border-b border-white/[0.06] px-5 pt-4 pb-3.5">
              <nav className="flex items-center gap-1 text-[12px] text-ink-500">
                <button type="button" onClick={() => onNavigate([])} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-ink-50">
                  <ArrowLeft className="size-3.5" /> Ana konuşma
                </button>
                {subagentPath(index, info.id).map((step, position, path) => (
                  <span key={step.id} className="flex min-w-0 items-center gap-1">
                    <ChevronRight className="size-3 shrink-0" />
                    <button
                      type="button"
                      disabled={position === path.length - 1}
                      onClick={() => onNavigate(path.slice(0, position + 1).map((item) => item.id))}
                      className="max-w-[220px] truncate rounded-md px-1.5 py-0.5 transition-colors enabled:hover:bg-white/[0.06] enabled:hover:text-ink-50 disabled:text-violet-glow"
                    >
                      {step.type}: {step.description}
                    </button>
                  </span>
                ))}
              </nav>
              <div className="mt-2 flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-xl bg-violet-glow/10 text-violet-glow ring-1 ring-violet-glow/25">
                  <Bot className="size-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-display text-[17px] font-semibold tracking-tight">{info.description}</h2>
                  <div className={`flex items-center gap-1.5 text-[12px] ${STATE_STYLE[info.state].tone}`}>
                    {STATE_STYLE[info.state].icon}
                    {STATE_STYLE[info.state].label}
                    <span className="text-ink-500">
                      · {info.type} · {info.steps} adım · {timeAgo(info.startedAt)} başladı
                    </span>
                  </div>
                </div>
              </div>
            </motion.header>
            <motion.div ref={scroller} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.14, duration: 0.25 } }} className="scroll-quiet flex-1 overflow-y-auto px-6 py-5">
              <Timeline events={events} scope={info.id} subagents={index} openIds={new Set(stack)} onOpenSubagent={(id) => onNavigate([...stack, id])} />
              {info.state === "running" && <p className="mt-4 text-[12px] text-harbor-300">Subagent çalışıyor; adımlar canlı akar.</p>}
            </motion.div>
            <footer className="border-t border-white/[0.06] px-5 py-3 text-[11.5px] text-ink-500">
              Subagent'a doğrudan yazılamaz; yönlendirmek için ana konuşmaya mesaj gönder. Esc ile geri dön.
            </footer>
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}
