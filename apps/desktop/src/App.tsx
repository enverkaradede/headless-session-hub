/** App shell: backdrop glows, sidebar, and the active view with section transitions. */
import { Anchor, Plus, RotateCw, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { NewSession } from "./app/NewSession";
import { SessionView } from "./app/SessionView";
import { SettingsView } from "./app/settings/SettingsView";
import { Sidebar } from "./app/Sidebar";
import { hub, useHub } from "./lib/store";
import { updater } from "./lib/updater";
import { Button, EmptyState } from "./ui/kit";
import { ToastProvider, useToasts } from "./ui/toasts";

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const view = useHub((state) => state.view);
  const { push } = useToasts();

  useEffect(() => closeViewOnEscape(), []);

  useEffect(() => {
    hub.start().catch((err: unknown) => push("error", err instanceof Error ? err.message : "Başlatılamadı"));
    updater.start();
  }, [push]);

  const viewKey = view.kind === "session" ? `${view.device}:${view.sessionId}` : view.kind;

  return (
    <div className="relative flex h-full overflow-hidden">
      <Backdrop />
      <Sidebar />
      <main className="relative z-10 min-w-0 flex-1">
        <AnimatePresence mode="wait">
          <motion.div key={viewKey} className="h-full" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}>
            {view.kind === "session" && <SessionView device={view.device} sessionId={view.sessionId} />}
            {view.kind === "new" && <NewSession />}
            {view.kind === "settings" && <SettingsView />}
            {view.kind === "home" && <Home />}
          </motion.div>
        </AnimatePresence>
      </main>
      <ConfirmLeave />
    </div>
  );
}

/** "Discard what you typed?" before a navigation would throw away unsaved input. */
function ConfirmLeave() {
  const pending = useHub((state) => state.pendingView);
  useEffect(() => {
    if (!pending) return;
    // Capture phase: while the dialog is open, Esc means "stay", never "close the screen".
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      hub.cancelLeave();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending]);
  return (
    <AnimatePresence>
      {pending && (
        <motion.div className="fixed inset-0 z-50 grid place-items-center bg-harbor-950/70 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => hub.cancelLeave()}>
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-leave-title"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            onClick={(event) => event.stopPropagation()}
            className="w-[400px] rounded-3xl border border-white/[0.08] bg-gradient-to-b from-harbor-850 to-harbor-900 p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]"
          >
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-beacon-400/10 text-beacon-300 ring-1 ring-beacon-400/25">
                <TriangleAlert className="size-5" />
              </span>
              <div>
                <h2 id="confirm-leave-title" className="font-display text-[17px] font-semibold tracking-tight">Yazdıkların silinecek</h2>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-400">Yeni oturum formunda kaydedilmemiş bir içerik var. Çıkarsan geri getirilemez.</p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="danger" onClick={() => hub.confirmLeave()}>
                Sil ve çık
              </Button>
              <Button variant="primary" autoFocus onClick={() => hub.cancelLeave()}>
                Kal
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Esc closes settings, the new-session form and an open session, back to home. Layers above a view
 * (subagent pane, dialogs, fields that revert on Esc) claim the key first with preventDefault().
 * In a text field the first Esc only leaves the field, so a half-written message is never lost.
 */
function closeViewOnEscape(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) {
      target.blur();
      return;
    }
    if (hub.getState().view.kind !== "home") hub.setView({ kind: "home" });
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

function Backdrop() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute -top-48 right-[-12%] size-[680px] rounded-full bg-harbor-600/25 blur-[120px]" />
      <div className="absolute bottom-[-32%] left-[18%] size-[560px] rounded-full bg-beacon-500/[0.07] blur-[120px]" />
    </div>
  );
}

function Home() {
  const engine = useHub((state) => state.engine);
  return (
    <div className="flex h-full flex-col">
      <div data-tauri-drag-region className="h-[54px] shrink-0" />
      <div className="grid flex-1 place-items-center pb-16">
        {engine.state === "restarting" ? (
          <EmptyState icon={RotateCw} title="Motor yeniden başlatılıyor" body={`${engine.reason}. ${Math.round(engine.delay_ms / 1000)} sn içinde tekrar denenecek.`} />
        ) : (
          <EmptyState
            icon={Anchor}
            title="Liman sakin"
            body="Soldan bir oturum seç ya da yenisini başlat. Bir oturum soru sorduğunda ya da izin istediğinde seni burada, en üstte bekler."
            action={
              <Button variant="primary" size="lg" icon={Plus} onClick={() => hub.setView({ kind: "new" })}>
                Yeni oturum
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
