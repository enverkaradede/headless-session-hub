/** App shell: backdrop glows, sidebar, and the active view with section transitions. */
import { Anchor, Plus, RotateCw } from "lucide-react";
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
    </div>
  );
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
