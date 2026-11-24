/** Sidebar update pill and the dialog that downloads, installs and relaunches. */
import { ArrowUpCircle, Download, RotateCcw, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { updater, useUpdater } from "../lib/updater";
import { Button } from "../ui/kit";

export function UpdatePill() {
  const state = useUpdater();
  const [open, setOpen] = useState(false);
  const visible = state.phase === "available" || state.phase === "downloading" || state.phase === "ready";
  return (
    <>
      <AnimatePresence>
        {visible && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            transition={{ type: "spring", stiffness: 500, damping: 34 }}
            onClick={() => setOpen(true)}
            className="mb-2 flex w-full items-center gap-2.5 rounded-xl border border-beacon-400/35 bg-gradient-to-r from-beacon-400/[0.16] to-beacon-400/[0.04] px-3 py-2.5 text-left shadow-[0_0_24px_-10px_rgba(255,169,92,0.8)]"
          >
            <ArrowUpCircle className="size-4 shrink-0 text-beacon-300" />
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-medium text-ink-50">{state.phase === "ready" ? "Yeniden başlatmaya hazır" : "Güncelleme hazır"}</span>
              <span className="block text-[11px] text-beacon-200/80">v{state.availableVersion}</span>
            </span>
          </motion.button>
        )}
      </AnimatePresence>
      <UpdateDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function UpdateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useUpdater();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 grid place-items-center bg-harbor-950/70 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            onClick={(event) => event.stopPropagation()}
            className="w-[480px] rounded-3xl border border-white/[0.08] bg-gradient-to-b from-harbor-850 to-harbor-900 p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]"
          >
            <div className="flex items-start gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-beacon-400/10 text-beacon-300 ring-1 ring-beacon-400/25">
                <Sparkles className="size-5" />
              </span>
              <div className="flex-1">
                <h2 className="font-display text-[18px] font-semibold tracking-tight">Session Hub {state.availableVersion}</h2>
                <p className="text-[12.5px] text-ink-400">Şu an v{state.currentVersion}. Çalışan oturumlar yeniden başlatmada durur.</p>
              </div>
              <button type="button" aria-label="Kapat" onClick={onClose} className="text-ink-500 hover:text-ink-50">
                <X className="size-4" />
              </button>
            </div>
            {state.notes && (
              <div className="prose-hub scroll-quiet mt-4 max-h-60 overflow-y-auto rounded-xl border border-white/[0.06] bg-harbor-950/50 p-4">
                <ReactMarkdown>{state.notes}</ReactMarkdown>
              </div>
            )}
            {state.phase === "downloading" && (
              <div className="mt-4">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <motion.div className="h-full rounded-full bg-gradient-to-r from-beacon-500 to-beacon-200" initial={false} animate={{ width: `${Math.round(state.progress * 100)}%` }} transition={{ ease: "easeOut", duration: 0.25 }} />
                </div>
                <p className="mt-1.5 text-right text-[11.5px] text-ink-500 tabular-nums">{Math.round(state.progress * 100)}%</p>
              </div>
            )}
            {state.phase === "error" && state.error && <p className="mt-4 text-[12.5px] text-rose-glow">{state.error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="subtle" onClick={onClose}>
                Sonra
              </Button>
              {state.phase === "ready" ? (
                <Button variant="primary" icon={RotateCcw} onClick={() => void updater.relaunch()}>
                  Yeniden başlat
                </Button>
              ) : (
                <Button variant="primary" icon={Download} loading={state.phase === "downloading"} disabled={state.phase !== "available" && state.phase !== "error"} onClick={() => void updater.install()}>
                  İndir ve kur
                </Button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
