/** Cards for a pending AskUserQuestion (options, multi-select, free text) and a permission request. */
import type { PendingRequest, Question, RequestAnswer } from "@hub/protocol";
import { Check, Clock, FolderLock, Hourglass, MessageCircleQuestion, ShieldCheck, ShieldQuestion, ShieldX, X } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { timeAgo } from "../lib/format";
import { Button, Chip, IconTile, Input } from "../ui/kit";

const cardMotion = {
  initial: { opacity: 0, y: 12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -8, scale: 0.98 },
  transition: { type: "spring" as const, stiffness: 420, damping: 34 },
};

function PolicyNote({ request }: { request: PendingRequest }) {
  if (request.state === "deferred") {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] text-violet-glow">
        <Hourglass className="size-3.5" /> Ertelendi: süreç kapandı, cevabınla kaldığı yerden devam edecek
      </span>
    );
  }
  if (request.expiresAt === null) return <span className="text-[11.5px] text-ink-500">{timeAgo(request.createdAt)} soruldu · süresiz bekliyor</span>;
  const action = request.policy.mode === "deny_after" ? "otomatik reddedilecek" : "ertelenecek";
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-ink-500">
      <Clock className="size-3.5" /> {timeAgo(request.expiresAt)} {action}
    </span>
  );
}

function ReadOnlyNote() {
  return <p className="text-[12px] text-ink-500">Bu cihazda salt okunur yetkin var; cevap veremezsin.</p>;
}

export function QuestionCard({ request, canAnswer, onAnswer }: { request: PendingRequest; canAnswer: boolean; onAnswer: (answer: RequestAnswer) => Promise<void> }) {
  const questions = request.questions ?? [];
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  const valueFor = (question: Question): string | string[] | null => {
    const picks = selected[question.question] ?? [];
    const free = (other[question.question] ?? "").trim();
    if (question.multiSelect) {
      const all = free ? [...picks, free] : picks;
      return all.length > 0 ? all : null;
    }
    return free || picks[0] || null;
  };
  const complete = questions.every((question) => valueFor(question) !== null);

  const toggle = (question: Question, label: string) => {
    setSelected((current) => {
      const picks = current[question.question] ?? [];
      const next = question.multiSelect ? (picks.includes(label) ? picks.filter((pick) => pick !== label) : [...picks, label]) : [label];
      return { ...current, [question.question]: next };
    });
    if (!question.multiSelect) setOther((current) => ({ ...current, [question.question]: "" }));
  };

  const submit = async () => {
    if (!complete) {
      setShake((value) => value + 1);
      return;
    }
    const answers: Record<string, string | string[]> = {};
    for (const question of questions) {
      const value = valueFor(question);
      if (value !== null) answers[question.question] = value;
    }
    setBusy(true);
    try {
      await onAnswer({ kind: "question", answers });
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div {...cardMotion} className="rounded-2xl border border-beacon-400/30 bg-gradient-to-b from-beacon-400/[0.09] to-harbor-850/80 p-5 shadow-[0_0_40px_-18px_rgba(255,169,92,0.6)]">
      <div className="flex items-start gap-3">
        <IconTile icon={MessageCircleQuestion} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-display text-[15px] font-semibold tracking-tight">Claude sana soruyor</h3>
            <PolicyNote request={request} />
          </div>
          <motion.div key={shake} animate={shake ? { x: [0, -5, 5, -4, 4, -2, 0] } : {}} transition={{ duration: 0.4 }} className="mt-4 space-y-5">
            {questions.map((question) => (
              <fieldset key={question.question} disabled={!canAnswer || busy}>
                <div className="flex items-center gap-2">
                  <Chip tone="beacon">{question.header}</Chip>
                  {question.multiSelect && <span className="text-[11px] text-ink-500">birden fazla seçebilirsin</span>}
                </div>
                <legend className="mt-2 text-[14px] leading-relaxed font-medium text-ink-50">{question.question}</legend>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {question.options.map((option) => {
                    const active = (selected[question.question] ?? []).includes(option.label);
                    return (
                      <motion.button
                        key={option.label}
                        type="button"
                        whileHover={{ y: -1 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => toggle(question, option.label)}
                        className={`relative flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                          active ? "border-beacon-400/60 bg-beacon-400/[0.12]" : "border-white/[0.08] bg-harbor-950/40 hover:border-white/15 hover:bg-harbor-900/60"
                        }`}
                      >
                        <span className={`mt-0.5 grid size-4 shrink-0 place-items-center border transition-colors ${question.multiSelect ? "rounded" : "rounded-full"} ${active ? "border-beacon-300 bg-beacon-400 text-harbor-950" : "border-white/25"}`}>
                          {active && <Check className="size-3" strokeWidth={3} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13.5px] font-medium text-ink-50">{option.label}</span>
                          {option.description && <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-400">{option.description}</span>}
                        </span>
                      </motion.button>
                    );
                  })}
                </div>
                <Input
                  value={other[question.question] ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setOther((current) => ({ ...current, [question.question]: value }));
                    if (!question.multiSelect && value) setSelected((current) => ({ ...current, [question.question]: [] }));
                  }}
                  placeholder="Ya da kendi cevabını yaz…"
                  className="mt-2 w-full"
                />
              </fieldset>
            ))}
          </motion.div>
          <div className="mt-5 flex items-center justify-end gap-3">
            {!canAnswer && <ReadOnlyNote />}
            <Button variant="primary" icon={Check} loading={busy} disabled={!canAnswer} onClick={() => void submit()}>
              Cevabı gönder
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export function PermissionCard({ request, canAnswer, onAnswer }: { request: PendingRequest; canAnswer: boolean; onAnswer: (answer: RequestAnswer) => Promise<void> }) {
  const [busy, setBusy] = useState<"allow" | "allow_session" | "deny" | null>(null);
  const [message, setMessage] = useState("");
  const [denying, setDenying] = useState(false);

  const decide = async (decision: "allow" | "allow_session" | "deny") => {
    setBusy(decision);
    try {
      await onAnswer({ kind: "permission", decision, ...(decision === "deny" && message.trim() ? { message: message.trim() } : {}) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.div {...cardMotion} className="rounded-2xl border border-beacon-400/30 bg-gradient-to-b from-beacon-400/[0.09] to-harbor-850/80 p-5 shadow-[0_0_40px_-18px_rgba(255,169,92,0.6)]">
      <div className="flex items-start gap-3">
        <IconTile icon={ShieldQuestion} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-display text-[15px] font-semibold tracking-tight">
              <span className="font-mono text-beacon-200">{request.toolName}</span> çalıştırmak için izin istiyor
            </h3>
            <PolicyNote request={request} />
          </div>
          {request.blockedPath && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-400">
              <FolderLock className="size-3.5" /> Çalışma dizini dışı: <span className="font-mono text-ink-200">{request.blockedPath}</span>
            </p>
          )}
          <pre className="scroll-quiet mt-3 max-h-56 overflow-auto rounded-xl border border-white/[0.07] bg-harbor-950/80 p-3.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-200">
            {request.inputPreview}
          </pre>
          {denying && (
            <Input autoFocus value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Claude'a neden reddettiğini söyle (isteğe bağlı)" className="mt-3 w-full" />
          )}
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            {!canAnswer && <ReadOnlyNote />}
            {denying ? (
              <>
                <Button variant="subtle" icon={X} onClick={() => setDenying(false)}>
                  Vazgeç
                </Button>
                <Button variant="danger" icon={ShieldX} loading={busy === "deny"} disabled={!canAnswer} onClick={() => void decide("deny")}>
                  Reddet
                </Button>
              </>
            ) : (
              <>
                <Button variant="danger" icon={ShieldX} disabled={!canAnswer || busy !== null} onClick={() => setDenying(true)}>
                  Reddet
                </Button>
                {request.canAllowForSession && (
                  <Button variant="ghost" icon={ShieldCheck} loading={busy === "allow_session"} disabled={!canAnswer || busy !== null} onClick={() => void decide("allow_session")} title="Aynı türdeki istekler bu oturumda tekrar sorulmaz">
                    Bu oturumda hep izin ver
                  </Button>
                )}
                <Button variant="primary" icon={Check} loading={busy === "allow"} disabled={!canAnswer || busy !== null} onClick={() => void decide("allow")}>
                  İzin ver
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
