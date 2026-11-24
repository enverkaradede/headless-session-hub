/** Devices (local only): this device's identity, remote control with per-device access, pairing, relay. */
import type { EngineSettings, PeerAccess } from "@hub/protocol";
import { Check, Copy, KeyRound, Laptop, Link2, Radio, Server, Trash2, Waypoints } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { ACCESS_HINT, ACCESS_LABEL, timeAgo } from "../../lib/format";
import { shell, type ClientDevice, type HostDevice } from "../../lib/ipc";
import { useHub } from "../../lib/store";
import { Button, Card, Chip, Row, Segmented, Select, StatusDot, TextArea, TextField, Toggle } from "../../ui/kit";
import { useToasts } from "../../ui/toasts";

const ACCESS_OPTIONS: ReadonlyArray<{ value: PeerAccess; label: string }> = [
  { value: "read_only", label: ACCESS_LABEL.read_only },
  { value: "operator", label: ACCESS_LABEL.operator },
  { value: "full", label: ACCESS_LABEL.full },
];
const PAIRING_TTL_MS = 10 * 60_000;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      icon={copied ? Check : Copy}
      onClick={() => void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })}
    >
      {copied ? "Kopyalandı" : "Kopyala"}
    </Button>
  );
}

export function DevicesSection({ settings, update }: { settings: EngineSettings | null; update: (patch: Partial<EngineSettings>, success?: string) => Promise<unknown> }) {
  const peers = useHub((state) => state.peers);
  const { push } = useToasts();
  const run = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) push("success", success);
    } catch (err) {
      push("error", err instanceof Error ? err.message : "İşlem başarısız");
    }
  };
  if (!peers) return null;

  return (
    <>
      <Card title="Bu cihaz" icon={Laptop} description="Diğer cihazlar bu cihazı bu adla görür. Kimlik, eşleştirmede kullanılan açık anahtardır.">
        <Row label="Cihaz adı" hint="Örn. Ofis PC, Evdeki Mac.">
          <TextField label="Cihaz adı" value={peers.deviceName} onCommit={(name) => void run(() => shell.setDeviceName(name), "Ad kaydedildi")} className="w-[240px]" />
        </Row>
        {peers.deviceId && (
          <Row label="Cihaz kimliği" hint="Eşleştirme kodu bunu içerir; tek başına erişim vermez.">
            <span className="block max-w-[260px] truncate font-mono text-[11.5px] text-ink-400">{peers.deviceId}</span>
          </Row>
        )}
      </Card>

      <Card title="Uzaktan kontrol" icon={Radio} description="Açıkken eşleştirdiğin cihazlar bu cihazdaki oturumları, verdiğin yetki kadar görüp yönetebilir. Bağlantı uçtan uca şifrelidir; port açman gerekmez.">
        <Row label="Bu cihazı uzaktan kontrole aç" hint={peers.hostEnabled ? "Açık: eşleşmiş cihazlar bağlanabilir." : "Kapalı: hiçbir cihaz bağlanamaz, yeni eşleştirme yapılamaz."}>
          <Toggle label="Uzaktan kontrol" checked={peers.hostEnabled} onChange={(next) => void run(() => shell.setHostEnabled(next))} />
        </Row>
        <AnimatePresence initial={false}>
          {peers.hostEnabled && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <PairingCodePanel />
              <ClientList clients={peers.clients} onAccess={(id, access) => void run(() => shell.setAccess(id, access), "Yetki güncellendi")} onRemove={(id) => void run(() => shell.removeDevice(id), "Eşleştirme kaldırıldı")} />
            </motion.div>
          )}
        </AnimatePresence>
        {settings && (
          <Row label="Sadece özet gönder" hint="Uzak cihazlar komut, dosya içeriği ve model metni görmez.">
            <Toggle label="Sadece özet gönder" checked={settings.summaryOnlyForPeers} onChange={(next) => void update({ summaryOnlyForPeers: next })} />
          </Row>
        )}
      </Card>

      <ConnectCard hosts={peers.hosts} onRemove={(id) => void run(() => shell.removeDevice(id), "Bağlantı kaldırıldı")} />

      <Card title="Ağ" icon={Waypoints} description="Doğrudan bağlantı kurulamazsa trafik şifreli bir relay üzerinden geçer. Relay içeriği göremez.">
        <Row label="Relay sunucusu" hint="Boş: n0'ın halka açık relay'leri. Kendi relay'in varsa URL'ini yaz.">
          <TextField label="Relay URL" value={peers.relayUrl ?? ""} placeholder="varsayılan" mono onCommit={(value) => void run(() => shell.setRelay(value.trim() || null), "Relay kaydedildi")} className="w-[280px]" />
        </Row>
      </Card>
    </>
  );
}

function PairingCodePanel() {
  const [access, setAccess] = useState<PeerAccess>("operator");
  const [code, setCode] = useState<{ value: string; expires: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { push } = useToasts();

  // The countdown ticks only while a code is on screen.
  useEffect(() => {
    if (!code) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [code]);

  const create = async () => {
    setBusy(true);
    try {
      const value = await shell.createPairingCode(access);
      setCode({ value, expires: Date.now() + PAIRING_TTL_MS });
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Kod oluşturulamadı");
    } finally {
      setBusy(false);
    }
  };

  const remaining = code ? Math.max(0, code.expires - now) : 0;
  const expired = code !== null && remaining === 0;

  return (
    <div className="mt-1 mb-4 rounded-xl border border-white/[0.06] bg-harbor-950/40 p-4">
      <div className="flex items-center gap-2 text-[13.5px] font-medium">
        <KeyRound className="size-4 text-beacon-300" /> Yeni cihaz eşleştir
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Segmented value={access} options={ACCESS_OPTIONS} onChange={setAccess} size="sm" />
        <Button variant="primary" size="sm" loading={busy} onClick={() => void create()}>
          Kod oluştur
        </Button>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-400">{ACCESS_HINT[access]}</p>
      <AnimatePresence initial={false}>
        {code && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 space-y-2">
            <div className={`rounded-lg border p-3 font-mono text-[11.5px] break-all ${expired ? "border-white/[0.06] text-ink-500 line-through" : "border-beacon-400/30 bg-beacon-400/[0.06] text-ink-50"}`}>{code.value}</div>
            <div className="flex items-center justify-between text-[12px] text-ink-400">
              <span>
                {expired
                  ? "Süresi doldu; yeni kod oluştur."
                  : `Tek kullanımlık. ${Math.floor(remaining / 60_000)}:${String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0")} içinde diğer cihazda "Başka bir cihaza bağlan" alanına yapıştır.`}
              </span>
              {!expired && <CopyButton text={code.value} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ClientList({ clients, onAccess, onRemove }: { clients: ClientDevice[]; onAccess: (id: string, access: PeerAccess) => void; onRemove: (id: string) => void }) {
  if (clients.length === 0) return <p className="mb-3 text-[12.5px] text-ink-500">Bu cihazı kontrol edebilen eşleşmiş cihaz yok.</p>;
  return (
    <ul className="mb-3 space-y-2">
      {clients.map((client) => (
        <li key={client.id} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-harbor-950/40 px-3.5 py-2.5">
          <StatusDot tone={client.connected ? "ok" : "idle"} />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium">{client.name}</div>
            <div className="text-[11.5px] text-ink-500">
              {client.connected ? "Bağlı" : "Bağlı değil"} · eşleşti {timeAgo(client.pairedAt * 1000)}
            </div>
          </div>
          <Select label="Yetki" value={client.access} options={ACCESS_OPTIONS} onChange={(access) => onAccess(client.id, access)} />
          <Button size="sm" variant="subtle" icon={Trash2} aria-label="Eşleştirmeyi kaldır" onClick={() => onRemove(client.id)} />
        </li>
      ))}
    </ul>
  );
}

function ConnectCard({ hosts, onRemove }: { hosts: HostDevice[]; onRemove: (id: string) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const { push } = useToasts();
  const pair = async () => {
    setBusy(true);
    try {
      const host = await shell.pairWith(code.trim());
      push("success", `${host.name} ile eşleşildi (${ACCESS_LABEL[host.access]})`);
      setCode("");
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Eşleştirme başarısız");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Başka bir cihaza bağlan" icon={Link2} description="Ofisteki bilgisayarda kod oluştur, buraya yapıştır. Bağlandıktan sonra o cihazın oturumları sol panelde ayrı grupta görünür.">
      <div className="flex items-start gap-2">
        <TextArea rows={2} value={code} onChange={(event) => setCode(event.target.value)} placeholder="SHUB1.…" className="flex-1 font-mono text-[12px]" />
        <Button variant="primary" loading={busy} disabled={!code.trim().startsWith("SHUB1.")} onClick={() => void pair()}>
          Bağlan
        </Button>
      </div>
      {hosts.length > 0 && (
        <ul className="mt-4 space-y-2">
          {hosts.map((host) => (
            <li key={host.id} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-harbor-950/40 px-3.5 py-2.5">
              <Server className="size-4 text-harbor-300" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13.5px] font-medium">
                  {host.name}
                  <Chip tone={host.access === "full" ? "beacon" : host.access === "operator" ? "jade" : "neutral"}>{ACCESS_LABEL[host.access]}</Chip>
                </div>
                <div className="flex items-center gap-1.5 text-[11.5px] text-ink-500">
                  <StatusDot tone={host.status === "online" ? "ok" : host.status === "connecting" ? "busy" : "idle"} size="sm" />
                  {host.status === "online" ? "Çevrimiçi" : host.status === "connecting" ? "Bağlanıyor…" : "Çevrimdışı"}
                </div>
              </div>
              <Button size="sm" variant="subtle" icon={Trash2} aria-label="Bağlantıyı kaldır" onClick={() => onRemove(host.id)} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
