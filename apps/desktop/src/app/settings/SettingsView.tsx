/** Settings: tabs for general, behaviour, integrations, devices (local only) and audit. */
import { Activity, Cable, ClipboardList, LoaderCircle, MonitorSmartphone, SlidersHorizontal } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type ComponentType } from "react";
import { LOCAL } from "../../lib/ipc";
import { useHub } from "../../lib/store";
import { Select } from "../../ui/kit";
import { AuditSection } from "./AuditSection";
import { BehaviourSection } from "./BehaviourSection";
import { DevicesSection } from "./DevicesSection";
import { GeneralSection } from "./GeneralSection";
import { IntegrationsSection } from "./IntegrationsSection";
import { useEngineSettings } from "./useEngineSettings";

type Tab = "general" | "behaviour" | "integrations" | "devices" | "audit";

const TABS: ReadonlyArray<{ id: Tab; label: string; icon: ComponentType<{ className?: string }>; localOnly?: boolean }> = [
  { id: "general", label: "Genel", icon: SlidersHorizontal },
  { id: "behaviour", label: "Davranış", icon: Activity },
  { id: "integrations", label: "Entegrasyonlar", icon: Cable },
  { id: "devices", label: "Cihazlar", icon: MonitorSmartphone, localOnly: true },
  { id: "audit", label: "Denetim", icon: ClipboardList },
];

export function SettingsView() {
  const peers = useHub((state) => state.peers);
  const localName = useHub((state) => state.devices[LOCAL]?.info?.hostname ?? "Bu cihaz");
  const [device, setDevice] = useState(LOCAL);
  const [tab, setTab] = useState<Tab>("general");
  const { settings, error, update } = useEngineSettings(device);

  // Remote settings are editable only on hosts that granted this device full access.
  const deviceOptions = useMemo(
    () => [
      { value: LOCAL, label: `${localName} (bu cihaz)` },
      ...(peers?.hosts ?? []).filter((host) => host.status === "online" && host.access === "full").map((host) => ({ value: host.id, label: host.name })),
    ],
    [peers, localName],
  );
  const tabs = TABS.filter((item) => !item.localOnly || device === LOCAL);
  const activeTab = tabs.some((item) => item.id === tab) ? tab : "general";

  return (
    <div className="scroll-quiet h-full overflow-y-auto">
      <div data-tauri-drag-region className="sticky top-0 z-20 h-[54px]" />
      <div className="mx-auto max-w-[760px] px-10 pb-16">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[26px] font-semibold tracking-tight">Ayarlar</h1>
            <p className="mt-1 text-[13.5px] text-ink-400">Oturumların nasıl çalışacağı, kime bağlanacağı ve neyin dışarı çıkacağı.</p>
          </div>
          {deviceOptions.length > 1 && <Select label="Ayarlanan cihaz" value={device} options={deviceOptions} onChange={setDevice} />}
        </div>

        <nav className="mb-6 flex gap-1 rounded-xl border border-white/[0.06] bg-harbor-900/50 p-1">
          {tabs.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeTab;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`relative flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${active ? "text-ink-50" : "text-ink-400 hover:text-ink-50"}`}
              >
                {active && (
                  <motion.span layoutId="settings-tab" className="absolute inset-0 rounded-lg bg-gradient-to-b from-beacon-400/[0.18] to-beacon-400/[0.06] ring-1 ring-beacon-400/25" transition={{ type: "spring", stiffness: 500, damping: 38 }} />
                )}
                <Icon className={`relative size-3.5 ${active ? "text-beacon-300" : ""}`} />
                <span className="relative">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {error ? (
          <p className="rounded-xl border border-rose-glow/30 bg-rose-glow/[0.07] p-4 text-[13px] text-rose-glow">{error}</p>
        ) : activeTab !== "devices" && activeTab !== "audit" && settings === null ? (
          <div className="grid h-48 place-items-center text-ink-400">
            <LoaderCircle className="size-5 animate-spin" />
          </div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div key={`${device}:${activeTab}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }} className="space-y-4">
              {activeTab === "general" && settings && <GeneralSection device={device} settings={settings} update={update} />}
              {activeTab === "behaviour" && settings && <BehaviourSection device={device} settings={settings} update={update} />}
              {activeTab === "integrations" && settings && <IntegrationsSection device={device} settings={settings} update={update} />}
              {activeTab === "devices" && <DevicesSection settings={settings} update={update} />}
              {activeTab === "audit" && <AuditSection device={device} />}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
