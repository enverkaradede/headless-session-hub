/** Integrations: Claude Code hooks per profile (claude -p compatibility), local API/hubctl, outgoing webhooks. */
import type { EngineSettings, HooksStatus, WebhookConfig, WebhookEvent } from "@hub/protocol";
import { Anchor, Check, Copy, Plus, Terminal, Trash2, Webhook, Wrench } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { LOCAL, rpc } from "../../lib/ipc";
import { useHub } from "../../lib/store";
import { Button, Card, Chip, Input, Row, Toggle } from "../../ui/kit";
import { useToasts } from "../../ui/toasts";

interface SectionProps {
  device: string;
  settings: EngineSettings;
  update: (patch: Partial<EngineSettings>, success?: string) => Promise<unknown>;
}

const EVENTS: ReadonlyArray<{ value: WebhookEvent; label: string }> = [
  { value: "session.started", label: "Başladı" },
  { value: "session.waiting", label: "Cevap bekliyor" },
  { value: "session.completed", label: "Bitti" },
  { value: "session.error", label: "Hata" },
  { value: "session.usage_limit", label: "Limit doldu" },
  { value: "session.deferred", label: "Ertelendi" },
];
const SECRET_BYTES = 32;

function randomSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })}
      className="grid size-7 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-white/[0.06] hover:text-ink-50"
    >
      {copied ? <Check className="size-3.5 text-jade" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-harbor-950/70 py-1 pr-1 pl-3">
      <span className="text-beacon-400">$</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-200">{command}</code>
      <CopyText text={command} label="Komutu kopyala" />
    </div>
  );
}

const HOOK_TOASTS = {
  install: "Hook'lar kuruldu; claude -p koşuları listede görünecek",
  uninstall: "Hook'lar kaldırıldı",
  repair: "Hook'lar onarıldı; bu kurulumun hubctl'ini kullanıyor",
} as const;

/** 0.1.x engines send no health: fall back to installed / not installed. */
function HookHealthChip({ installed, health }: { installed: boolean; health: HooksStatus["profiles"][number]["health"] }) {
  if (health === "broken") return <Chip tone="rose">Onarılmalı</Chip>;
  return installed ? <Chip tone="jade">Kurulu</Chip> : <Chip>Kurulu değil</Chip>;
}

export function IntegrationsSection({ device, settings, update }: SectionProps) {
  const info = useHub((state) => state.devices[device]?.info ?? null);
  const [hooks, setHooks] = useState<HooksStatus | null>(null);
  const [busyProfile, setBusyProfile] = useState<string | null>(null);
  const { push } = useToasts();

  const loadHooks = useCallback(() => {
    rpc(device, "hooks.status", {})
      .then(setHooks)
      .catch((err: unknown) => push("error", err instanceof Error ? err.message : "Hook durumu okunamadı"));
  }, [device, push]);
  useEffect(loadHooks, [loadHooks]);

  const changeHooks = async (profileId: string, action: "install" | "uninstall" | "repair") => {
    setBusyProfile(profileId);
    try {
      setHooks(await rpc(device, action === "uninstall" ? "hooks.uninstall" : "hooks.install", { profileId }));
      push("success", HOOK_TOASTS[action]);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Değiştirilemedi");
    } finally {
      setBusyProfile(null);
    }
  };

  const hubctl = hooks?.hubctlPath ? `"${hooks.hubctlPath}"` : "hubctl";

  return (
    <>
      <Card title="claude -p uyumluluğu" icon={Anchor} description="Hook'lar kurulunca mevcut claude -p script'leri değişmeden listede görünür ve izin istekleri buraya düşer. Etkileşimli terminal oturumları gösterilmez.">
        {hooks === null ? null : (
          <div className="space-y-2">
            {hooks.profiles.map((profile) => {
              const name = settings.profiles.find((candidate) => candidate.id === profile.profileId)?.name ?? profile.profileId;
              return (
                <div key={profile.profileId} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-harbor-950/40 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13.5px] font-medium">
                      {name}
                      <HookHealthChip installed={profile.installed} health={profile.health} />
                    </div>
                    <div className="truncate font-mono text-[11.5px] text-ink-500">{profile.settingsPath}</div>
                    {profile.health === "broken" && (
                      <p className="mt-1 text-[12px] leading-relaxed text-rose-glow/90">Hook'lar eksik ya da artık bulunmayan bir hubctl'i gösteriyor; uygulama taşınmış ya da yeniden kurulmuş olabilir.</p>
                    )}
                  </div>
                  {profile.health === "broken" && hooks.hubctlPath && (
                    <Button size="sm" variant="primary" icon={Wrench} loading={busyProfile === profile.profileId} disabled={busyProfile !== null} onClick={() => void changeHooks(profile.profileId, "repair")}>
                      Onar
                    </Button>
                  )}
                  <Toggle label={`${name} hook'ları`} checked={profile.installed} disabled={busyProfile !== null || !hooks.hubctlPath} onChange={(next) => void changeHooks(profile.profileId, next ? "install" : "uninstall")} />
                </div>
              );
            })}
            {!hooks.hubctlPath && <p className="text-[12px] text-beacon-200">Bu kurulumda hubctl bulunamadı; hook'lar kurulamaz.</p>}
            <p className="pt-1 text-[12px] leading-relaxed text-ink-500">Mevcut settings.json'daki diğer hook'lara dokunulmaz; ilk değişiklikten önce yedeği alınır (.session-hub.bak).</p>
          </div>
        )}
      </Card>

      <Card title="Yerel API ve hubctl" icon={Terminal} description="Arka plan servislerin oturum başlatıp cevap bekleyebilmesi için. Sadece bu bilgisayardan (127.0.0.1) ve token ile erişilir.">
        {device === LOCAL ? (
          <div className="space-y-2.5">
            <Row label="Port" hint="Token ve port, hubctl'ın okuduğu engine.json dosyasındadır (uygulama veri klasörü, sadece senin kullanıcın okuyabilir).">
              <span className="font-mono text-[13px] text-ink-200 tabular-nums">{info?.apiPort ?? "—"}</span>
            </Row>
            <div className="space-y-1.5 border-t border-white/[0.05] pt-3.5">
              <div className="text-[12.5px] text-ink-400">claude yerine hubctl run yaz; oturum otomatik kaydolur:</div>
              <CommandLine command={`${hubctl} run --name "Gece testi" --label ci -- -p "testleri çalıştır"`} />
              <CommandLine command={`${hubctl} sessions --status waiting_input,waiting_permission`} />
            </div>
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-500">Yerel API yalnızca o cihazın kendi üzerinde kullanılabilir.</p>
        )}
      </Card>

      <WebhooksCard settings={settings} update={update} canSeeSecrets={device === LOCAL} />
    </>
  );
}

function WebhooksCard({ settings, update, canSeeSecrets }: { settings: EngineSettings; update: SectionProps["update"]; canSeeSecrets: boolean }) {
  const [draft, setDraft] = useState<{ url: string; events: WebhookEvent[] } | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  const add = async () => {
    if (!draft) return;
    const hook: WebhookConfig = { id: crypto.randomUUID(), url: draft.url.trim(), events: draft.events, secret: randomSecret(), enabled: true };
    await update({ webhooks: [...settings.webhooks, hook] }, "Webhook eklendi");
    setRevealed(hook.secret);
    setDraft(null);
  };
  const patch = (id: string, change: Partial<WebhookConfig>) => update({ webhooks: settings.webhooks.map((hook) => (hook.id === id ? { ...hook, ...change } : hook)) });

  return (
    <Card
      title="Giden webhook'lar"
      icon={Webhook}
      description="Oturum olaylarını bir URL'e POST eder (HMAC-SHA256 imzalı, x-session-hub-signature). Mesajlar gönderilmeden önce maskelenir."
      actions={
        !draft && (
          <Button size="sm" icon={Plus} onClick={() => setDraft({ url: "", events: ["session.completed", "session.error", "session.usage_limit"] })}>
            Ekle
          </Button>
        )
      }
    >
      <AnimatePresence initial={false}>
        {revealed && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mb-3 overflow-hidden">
            <div className="rounded-xl border border-beacon-400/30 bg-beacon-400/[0.07] p-3">
              <div className="text-[12.5px] text-beacon-200">İmza anahtarı. Alıcı serviste doğrulama için kullan; bu ekranı kapatınca bir daha gösterilmez.</div>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-50">{revealed}</code>
                <CopyText text={revealed} label="Anahtarı kopyala" />
                <Button size="sm" variant="subtle" onClick={() => setRevealed(null)}>
                  Tamam
                </Button>
              </div>
            </div>
          </motion.div>
        )}
        {draft && (
          <motion.div key="draft" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mb-3 overflow-hidden">
            <div className="space-y-3 rounded-xl border border-white/[0.08] bg-harbor-950/40 p-3.5">
              <Input autoFocus value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://servisim.local/hooks/claude" mono className="w-full" />
              <div className="flex flex-wrap gap-1.5">
                {EVENTS.map((event) => {
                  const active = draft.events.includes(event.value);
                  return (
                    <button
                      key={event.value}
                      type="button"
                      onClick={() => setDraft({ ...draft, events: active ? draft.events.filter((item) => item !== event.value) : [...draft.events, event.value] })}
                      className={`h-7 rounded-lg border px-2.5 text-[12px] transition-colors ${active ? "border-beacon-400/50 bg-beacon-400/[0.12] text-beacon-200" : "border-white/10 text-ink-400 hover:text-ink-50"}`}
                    >
                      {event.label}
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="subtle" onClick={() => setDraft(null)}>
                  Vazgeç
                </Button>
                <Button variant="primary" disabled={!/^https?:\/\/\S+$/i.test(draft.url.trim()) || draft.events.length === 0} onClick={() => void add()}>
                  Kaydet
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {settings.webhooks.length === 0 && !draft ? (
        <p className="text-[12.5px] text-ink-500">Henüz webhook yok. Örneğin bir iş kuyruğu servisi, limit dolunca kuyruğunu durdurmak için session.usage_limit olayını dinleyebilir.</p>
      ) : (
        <ul className="space-y-2">
          {settings.webhooks.map((hook) => (
            <li key={hook.id} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-harbor-950/40 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12.5px] text-ink-50">{hook.url}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {hook.events.map((event) => (
                    <Chip key={event}>{EVENTS.find((item) => item.value === event)?.label ?? event}</Chip>
                  ))}
                </div>
              </div>
              {canSeeSecrets && <CopyText text={hook.secret} label="İmza anahtarını kopyala" />}
              <Toggle label="Etkin" checked={hook.enabled} onChange={(enabled) => void patch(hook.id, { enabled })} />
              <Button size="sm" variant="subtle" icon={Trash2} aria-label="Sil" onClick={() => void update({ webhooks: settings.webhooks.filter((item) => item.id !== hook.id) }, "Webhook silindi")} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
