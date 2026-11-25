/** Chat-style timeline: user/assistant bubbles, collapsible tool calls paired with their results, system lines. */
import type { TimelineEvent } from "@hub/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Brain, Check, ChevronRight, CircleAlert, Copy, FileText, Flag, Globe, Hammer, MessageCircleQuestion, Send, ShieldQuestion, SquareTerminal } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatClock, formatCost } from "../lib/format";
import { SubagentCard } from "./SubagentPane";
import { handbackReport, isSubagentCall, type SubagentInfo } from "./subagents";

const EMPTY_SET: ReadonlySet<string> = new Set();

type Item =
  | { kind: "event"; event: TimelineEvent }
  | { kind: "tool"; use: TimelineEvent; result: TimelineEvent | null }
  | { kind: "subagent"; id: string }
  | { kind: "handback"; event: TimelineEvent; report: string };

/** The empty zero-turn result older engines stored when the CLI closed; it is not a turn. */
function isEmptyClosingResult(event: TimelineEvent): boolean {
  const data = (event.data ?? {}) as { turns?: number; subtype?: string };
  return event.kind === "result" && data.turns === 0 && (data.subtype ?? "success") === "success" && event.text === "Finished";
}

/**
 * Items of one conversation scope (main = null, or a subagent's call id). Every tool_use is paired
 * with its tool_result; subagent calls become cards; subagent status lines stay on their own track.
 */
function buildItems(events: readonly TimelineEvent[], scope: string | null): Item[] {
  const scoped = events.filter((event) => event.parentToolUseId === scope);
  const results = new Map<string, TimelineEvent>();
  for (const event of scoped) {
    if (event.kind === "tool_result" && event.toolUseId) results.set(event.toolUseId, event);
  }
  const items: Item[] = [];
  for (const event of scoped) {
    if (event.kind === "tool_result" && event.toolUseId) continue;
    if (event.kind === "status" && event.parentToolUseId !== null) continue; // summarised on the card
    if (isEmptyClosingResult(event)) continue;
    const report = handbackReport(event);
    if (report) items.push({ kind: "handback", event, report });
    else if (isSubagentCall(event) && event.toolUseId) items.push({ kind: "subagent", id: event.toolUseId });
    else if (event.kind === "tool_use") items.push({ kind: "tool", use: event, result: event.toolUseId ? (results.get(event.toolUseId) ?? null) : null });
    else items.push({ kind: "event", event });
  }
  return items;
}

export const Timeline = memo(function Timeline({
  events,
  scope = null,
  subagents,
  openIds = EMPTY_SET,
  onOpenSubagent,
}: {
  events: readonly TimelineEvent[];
  scope?: string | null;
  subagents: Map<string, SubagentInfo>;
  openIds?: ReadonlySet<string>;
  onOpenSubagent: (id: string) => void;
}) {
  const items = useMemo(() => buildItems(events, scope), [events, scope]);
  return (
    <div className="space-y-3">
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.div
            key={item.kind === "tool" ? `t${item.use.seq}` : item.kind === "subagent" ? `a${item.id}` : item.kind === "handback" ? `h${item.event.seq}` : `e${item.event.seq}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
          >
            {item.kind === "tool" ? (
              <ToolRow use={item.use} result={item.result} />
            ) : item.kind === "subagent" ? (
              (() => {
                const info = subagents.get(item.id);
                return info ? <SubagentCard info={info} open={openIds.has(item.id)} onOpen={() => onOpenSubagent(item.id)} /> : null;
              })()
            ) : item.kind === "handback" ? (
              <HandbackRow report={item.report} />
            ) : (
              <EventRow event={item.event} />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
});

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Kopyala"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
      className="grid size-6 place-items-center rounded-md text-ink-500 opacity-0 transition-all group-hover:opacity-100 hover:bg-white/[0.06] hover:text-ink-50"
    >
      {copied ? <Check className="size-3.5 text-jade" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-hub">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links never navigate the app window: only http(s) URLs open, in the system browser.
          a: ({ children, href }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href && /^https?:\/\//i.test(href)) void openUrl(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** A subagent's report to the conversation that started it, shown as its final message. */
function HandbackRow({ report }: { report: string }) {
  return (
    <div className="group flex gap-1.5">
      <div className="max-w-[86%] rounded-2xl rounded-tl-md border border-violet-glow/25 bg-violet-glow/[0.06] px-4 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-violet-glow">
          <Send className="size-3" /> Ana konuşmaya rapor
        </div>
        <Markdown text={report} />
      </div>
      <CopyButton text={report} />
    </div>
  );
}

function EventRow({ event }: { event: TimelineEvent }) {
  switch (event.kind) {
    case "user_message":
      return (
        <div className="group flex justify-end gap-1.5">
          <CopyButton text={event.text} />
          <div className="max-w-[78%] rounded-2xl rounded-tr-md border border-beacon-400/20 bg-gradient-to-b from-beacon-400/[0.13] to-beacon-400/[0.06] px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-50">
            {event.text}
          </div>
        </div>
      );
    case "assistant_text":
      return (
        <div className="group flex gap-1.5">
          <div className="max-w-[86%] rounded-2xl rounded-tl-md border border-white/[0.06] bg-harbor-850/70 px-4 py-2.5">
            <Markdown text={event.text} />
          </div>
          <CopyButton text={event.text} />
        </div>
      );
    case "thinking":
      return <Collapsible icon={<Brain className="size-3.5" />} title="Düşünme" tone="muted" body={<p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-400">{event.text}</p>} />;
    case "request_opened": {
      const isQuestion = (event.data as { kind?: string } | null)?.kind === "question";
      return (
        <SystemLine icon={isQuestion ? <MessageCircleQuestion className="size-3.5" /> : <ShieldQuestion className="size-3.5" />} tone="beacon" ts={event.ts}>
          {isQuestion ? "Soru soruldu: " : "İzin istendi: "}
          <span className="text-ink-200">{event.text}</span>
        </SystemLine>
      );
    }
    case "request_closed":
      return (
        <SystemLine icon={<Check className="size-3.5" />} tone={event.text === "answered" ? "jade" : "muted"} ts={event.ts}>
          {event.text === "answered" ? "Cevaplandı" : event.text === "expired" ? "Süre doldu, otomatik reddedildi" : "İptal edildi"}
        </SystemLine>
      );
    case "result": {
      const data = (event.data ?? {}) as { costUsd?: number; turns?: number; subtype?: string };
      return (
        <div className="flex items-center gap-3 py-1 text-[11.5px] text-ink-500">
          <span className="h-px flex-1 bg-white/[0.06]" />
          <Flag className="size-3.5 text-jade" />
          <span>
            {data.subtype === "success" || data.subtype === undefined ? "Tur tamamlandı" : `Bitti: ${data.subtype}`}
            {data.turns ? ` · ${data.turns} adım` : ""}
            {data.costUsd ? ` · ≈${formatCost(data.costUsd)}` : ""} · {formatClock(event.ts)}
          </span>
          <span className="h-px flex-1 bg-white/[0.06]" />
        </div>
      );
    }
    case "error":
      return (
        <SystemLine icon={<CircleAlert className="size-3.5" />} tone="rose" ts={event.ts}>
          {event.text}
        </SystemLine>
      );
    default:
      return (
        <SystemLine icon={<ChevronRight className="size-3.5" />} tone="muted" ts={event.ts}>
          {event.text}
        </SystemLine>
      );
  }
}

const TOOL_ICONS: Record<string, ReactNode> = {
  Bash: <SquareTerminal className="size-3.5" />,
  Read: <FileText className="size-3.5" />,
  Write: <FileText className="size-3.5" />,
  Edit: <FileText className="size-3.5" />,
  WebFetch: <Globe className="size-3.5" />,
  WebSearch: <Globe className="size-3.5" />,
  AskUserQuestion: <MessageCircleQuestion className="size-3.5" />,
};

/** One-line summary of a tool call: the command, path or URL. */
function toolSummary(use: TimelineEvent): string {
  const input = (use.data ?? {}) as Record<string, unknown>;
  const pick = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  return (pick("command") ?? pick("file_path") ?? pick("url") ?? pick("pattern") ?? pick("query") ?? pick("description") ?? "").split("\n")[0] ?? "";
}

function ToolRow({ use, result }: { use: TimelineEvent; result: TimelineEvent | null }) {
  const isError = (result?.data as { isError?: boolean } | null)?.isError === true;
  return (
    <Collapsible
      icon={TOOL_ICONS[use.toolName ?? ""] ?? <Hammer className="size-3.5" />}
      title={use.toolName ?? "Araç"}
      summary={toolSummary(use)}
      tone={isError ? "rose" : "tool"}
      trailing={result ? null : <span className="text-[11px] text-ink-500">çalışıyor…</span>}
      body={
        <div className="space-y-2">
          <pre className="scroll-quiet max-h-64 overflow-auto rounded-lg border border-white/[0.06] bg-harbor-950/80 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-200">
            {JSON.stringify(use.data, null, 2)}
          </pre>
          {result && (
            <pre className={`scroll-quiet max-h-72 overflow-auto rounded-lg border p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap ${isError ? "border-rose-glow/25 bg-rose-glow/[0.06] text-rose-glow" : "border-white/[0.06] bg-harbor-950/60 text-ink-400"}`}>
              {result.text || "(boş çıktı)"}
            </pre>
          )}
        </div>
      }
    />
  );
}

function Collapsible({ icon, title, summary, body, tone, trailing }: {
  icon: ReactNode;
  title: string;
  summary?: string;
  body: ReactNode;
  tone: "tool" | "muted" | "rose";
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const toneClass = tone === "rose" ? "text-rose-glow" : tone === "tool" ? "text-harbor-300" : "text-ink-500";
  return (
    <div className="rounded-xl border border-white/[0.05] bg-harbor-900/40">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ type: "spring", stiffness: 500, damping: 32 }} className="text-ink-500">
          <ChevronRight className="size-3.5" />
        </motion.span>
        <span className={toneClass}>{icon}</span>
        <span className="text-[12.5px] font-medium text-ink-200">{title}</span>
        {summary && <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-500">{summary}</span>}
        {trailing}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
            <div className="px-3 pb-3">{body}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SystemLine({ icon, tone, ts, children }: { icon: ReactNode; tone: "beacon" | "jade" | "rose" | "muted"; ts: number; children: ReactNode }) {
  const tones = { beacon: "text-beacon-300", jade: "text-jade", rose: "text-rose-glow", muted: "text-ink-500" };
  return (
    <div className="flex items-center gap-2 px-1 text-[12px] text-ink-400">
      <span className={tones[tone]}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="shrink-0 text-[11px] text-ink-500 tabular-nums">{formatClock(ts)}</span>
    </div>
  );
}
