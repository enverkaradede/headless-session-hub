/** One session: header with status and stats, live timeline, pending request cards and the composer. */
import type { PendingRequest, RequestAnswer, SessionSummary } from "@hub/protocol";
import { ArrowUp, CircleAlert, Gauge, Hourglass, LoaderCircle, Play, Square, Tag } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ATTENTION, STATUS_LABEL, STATUS_TONE, epochToMs, formatCost, formatDateTime, formatTokens, timeAgo } from "../lib/format";
import { LOCAL, rpc } from "../lib/ipc";
import { hub, timelineKey, useHub } from "../lib/store";
import { Button, Chip, StatusDot, TextArea } from "../ui/kit";
import { useToasts } from "../ui/toasts";
import { PermissionCard, QuestionCard } from "./RequestCards";
import { Timeline } from "./Timeline";

const NEAR_BOTTOM_PX = 140;
const EMPTY_REQUESTS: PendingRequest[] = [];

/** Whether this device may answer or drive sessions on `device` (remote access is decided by the host). */
export function useCanOperate(device: string): boolean {
  const peers = useHub((state) => state.peers);
  if (device === LOCAL) return true;
  const access = peers?.hosts.find((host) => host.id === device)?.access;
  return access === "operator" || access === "full";
}

export function SessionView({ device, sessionId }: { device: string; sessionId: string }) {
  const session = useHub((state) => state.devices[device]?.sessions[sessionId]);
  const events = useHub((state) => state.timelines[timelineKey(device, sessionId)]);
  const allRequests = useHub((state) => state.devices[device]?.requests[sessionId] ?? EMPTY_REQUESTS);
  const deviceName = useHub((state) => (device === LOCAL ? null : (state.devices[device]?.name ?? null)));
  const canOperate = useCanOperate(device);
  const { push } = useToasts();
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const pending = useMemo(() => allRequests.filter((request) => request.state === "open" || request.state === "deferred"), [allRequests]);

  // Follow new output unless the owner scrolled up to read.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [events?.length, pending.length]);

  useEffect(() => {
    stickToBottom.current = true;
  }, [sessionId]);

  if (!session) {
    return (
      <div className="grid h-full place-items-center text-ink-400">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }

  const answer = async (request: PendingRequest, value: RequestAnswer) => {
    try {
      await rpc(device, "sessions.answer", { sessionId, requestId: request.id, answer: value });
      push("success", "Cevap iletildi");
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Cevap gönderilemedi");
      throw err;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <SessionHeader session={session} device={device} deviceName={deviceName} canOperate={canOperate} />
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
        }}
        className="scroll-quiet flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-[860px] px-8 pt-4 pb-6">
          {events === undefined ? (
            <div className="grid h-40 place-items-center text-ink-400">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : (
            <Timeline events={events} />
          )}
          <SessionBanners session={session} device={device} canOperate={canOperate} />
          <div className="mt-4 space-y-4">
            <AnimatePresence initial={false}>
              {pending.map((request) =>
                request.kind === "question" ? (
                  <QuestionCard key={request.id} request={request} canAnswer={canOperate} onAnswer={(value) => answer(request, value)} />
                ) : (
                  <PermissionCard key={request.id} request={request} canAnswer={canOperate} onAnswer={(value) => answer(request, value)} />
                ),
              )}
            </AnimatePresence>
          </div>
          {session.status === "running" || session.status === "starting" ? <WorkingIndicator /> : null}
        </div>
      </div>
      <Composer session={session} device={device} canOperate={canOperate} />
    </div>
  );
}

function SessionHeader({ session, device, deviceName, canOperate }: { session: SessionSummary; device: string; deviceName: string | null; canOperate: boolean }) {
  const { push } = useToasts();
  const [stopping, setStopping] = useState(false);
  const stoppable = session.live || ["starting", "running", "waiting_input", "waiting_permission", "deferred"].includes(session.status);
  const stop = async () => {
    setStopping(true);
    try {
      await rpc(device, "sessions.stop", { sessionId: session.id });
      push("info", "Oturum durduruldu");
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Durdurulamadı");
    } finally {
      setStopping(false);
    }
  };
  return (
    <header className="relative border-b border-white/[0.05] bg-harbor-900/30 backdrop-blur-xl">
      <div data-tauri-drag-region className="h-[38px]" />
      <div className="mx-auto flex max-w-[860px] items-start gap-4 px-8 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <StatusDot tone={STATUS_TONE[session.status]} />
            <h1 className="truncate font-display text-[20px] font-semibold tracking-tight">{session.name}</h1>
            <Chip tone={ATTENTION.has(session.status) ? "beacon" : session.status === "error" ? "rose" : session.status === "done" ? "jade" : "neutral"}>{STATUS_LABEL[session.status]}</Chip>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-500">
            {deviceName && <span className="text-harbor-300">{deviceName}</span>}
            <span className="max-w-[420px] truncate font-mono text-[11.5px]" title={session.cwd}>
              {session.cwd}
            </span>
            {session.model && <span>{session.model}</span>}
            <span title={formatDateTime(session.createdAt)}>başladı {timeAgo(session.createdAt)}</span>
            <span className="flex items-center gap-1 tabular-nums" title="İstemci tarafında hesaplanan tahmin; abonelikte fatura değildir">
              <Gauge className="size-3.5" />≈{formatCost(session.costUsd)} · {formatTokens(session.inputTokens)}↓ {formatTokens(session.outputTokens)}↑
            </span>
            {session.labels.map((label) => (
              <span key={label} className="flex items-center gap-1 text-ink-400">
                <Tag className="size-3" />
                {label}
              </span>
            ))}
          </div>
        </div>
        {stoppable && canOperate && (
          <Button variant="danger" icon={Square} loading={stopping} onClick={() => void stop()}>
            Durdur
          </Button>
        )}
      </div>
    </header>
  );
}

function SessionBanners({ session, device, canOperate }: { session: SessionSummary; device: string; canOperate: boolean }) {
  const { push } = useToasts();
  const [busy, setBusy] = useState(false);
  const resume = async (text: string) => {
    setBusy(true);
    try {
      await rpc(device, "sessions.message", { sessionId: session.id, text });
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Devam ettirilemedi");
    } finally {
      setBusy(false);
    }
  };
  if (session.status === "usage_limit" && session.usageLimit) {
    const resets = session.usageLimit.resetsAt ? formatDateTime(epochToMs(session.usageLimit.resetsAt)) : null;
    const overage = session.usageLimit.kind === "overage";
    return (
      <Banner tone="rose" icon={<CircleAlert className="size-4" />}>
        <div className="flex-1">
          <div className="font-medium text-ink-50">{overage ? "Abonelik ücretli kullanım kredisine geçti; oturum duraklatıldı." : "Kullanım limiti doldu."}</div>
          <div className="mt-0.5 text-ink-400">
            {resets ? `Limit ${resets} civarında sıfırlanır. ` : ""}Session Hub hiçbir koşulda kendiliğinden API anahtarına geçmez; devam etmek senin kararın.
          </div>
        </div>
        {canOperate && (
          <Button variant="ghost" icon={Play} loading={busy} onClick={() => void resume("Continue where you left off.")}>
            Devam et
          </Button>
        )}
      </Banner>
    );
  }
  if (session.status === "error" && session.errorMessage) {
    return (
      <Banner tone="rose" icon={<CircleAlert className="size-4" />}>
        <div className="flex-1">
          <div className="font-medium text-ink-50">Oturum hatayla bitti</div>
          <div className="mt-0.5 font-mono text-[12px] whitespace-pre-wrap text-ink-400">{session.errorMessage}</div>
        </div>
      </Banner>
    );
  }
  if (session.status === "deferred") {
    return (
      <Banner tone="violet" icon={<Hourglass className="size-4" />}>
        <div className="flex-1 text-ink-200">Bekleyen istek ertelendi ve süreç kapatıldı. Cevap verdiğinde oturum geçmişiyle birlikte kaldığı yerden devam eder.</div>
      </Banner>
    );
  }
  return null;
}

function Banner({ tone, icon, children }: { tone: "rose" | "violet"; icon: React.ReactNode; children: React.ReactNode }) {
  const tones = { rose: "border-rose-glow/30 bg-rose-glow/[0.07] text-rose-glow", violet: "border-violet-glow/30 bg-violet-glow/[0.07] text-violet-glow" };
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={`mt-4 flex items-start gap-3 rounded-xl border p-4 text-[13px] ${tones[tone]}`}>
      <span className="mt-0.5">{icon}</span>
      {children}
    </motion.div>
  );
}

function WorkingIndicator() {
  return (
    <div className="mt-4 flex items-center gap-2 px-1 text-[12px] text-harbor-300">
      <span className="flex gap-1">
        {[0, 1, 2].map((index) => (
          <motion.span
            key={index}
            className="size-1.5 rounded-full bg-harbor-300"
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: index * 0.18 }}
          />
        ))}
      </span>
      Claude çalışıyor
    </div>
  );
}

function Composer({ session, device, canOperate }: { session: SessionSummary; device: string; canOperate: boolean }) {
  const { push } = useToasts();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const externallyRunning = session.origin === "hook" && !["done", "error", "usage_limit"].includes(session.status);
  const resumes = !session.live;
  const disabled = !canOperate || externallyRunning;
  const placeholder = !canOperate
    ? "Bu cihazda salt okunur yetkin var."
    : externallyRunning
      ? "Bu oturum harici bir claude -p sürecinde çalışıyor; bitince mesajla devam ettirebilirsin."
      : resumes
        ? "Mesaj yaz; oturum geçmişiyle birlikte kaldığı yerden devam eder…"
        : "Claude'a mesaj gönder…";

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await rpc(device, "sessions.message", { sessionId: session.id, text: trimmed });
      setText("");
      void hub.loadSession(device, session.id);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Gönderilemedi");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="border-t border-white/[0.05] bg-harbor-900/40 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[860px] items-end gap-3 px-8 py-4">
        <TextArea
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="max-h-48 min-h-[42px] flex-1 disabled:opacity-50"
        />
        <Button variant="primary" size="lg" icon={resumes ? Play : ArrowUp} loading={sending} disabled={disabled || !text.trim()} onClick={() => void send()} className="h-[42px]">
          {resumes ? "Devam ettir" : "Gönder"}
        </Button>
      </div>
    </div>
  );
}
