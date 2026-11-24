/** About: version, engine and Claude versions, update controls and credits. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { formatDateTime } from "../../lib/format";
import { LOCAL } from "../../lib/ipc";
import { useHub } from "../../lib/store";
import { RELEASES_URL, updater, useUpdater, type UpdatePhase } from "../../lib/updater";
import { Button, Card, Row, Toggle } from "../../ui/kit";
import { BeaconMark } from "../Brand";
import { UpdateDialog } from "../UpdateDialog";

const PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: "Henüz denetlenmedi",
  checking: "Denetleniyor…",
  up_to_date: "Güncelsin",
  available: "Yeni sürüm var",
  downloading: "İndiriliyor…",
  ready: "Yeniden başlatmaya hazır",
  unreachable: "Güncelleme sunucusuna ulaşılamadı",
  error: "Güncelleme başarısız",
};

export function AboutSection() {
  const update = useUpdater();
  const info = useHub((state) => state.devices[LOCAL]?.info ?? null);
  const [dialog, setDialog] = useState(false);
  return (
    <>
      <Card>
        <div className="flex items-center gap-4">
          <div className="grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-harbor-600 to-harbor-950 shadow-[0_12px_30px_-12px_rgba(44,108,128,0.9)] ring-1 ring-beacon-400/30">
            <BeaconMark className="size-11" />
          </div>
          <div>
            <h2 className="font-display text-[22px] font-semibold tracking-tight">Session Hub</h2>
            <p className="font-mono text-[12.5px] text-beacon-200 tabular-nums">v{update.currentVersion ?? "…"}</p>
            <p className="mt-1 text-[12.5px] text-ink-400">Enver Karadede tarafından geliştirildi.</p>
          </div>
        </div>
      </Card>

      <Card title="Güncellemeler" description="İmzalı sürümler GitHub Releases'ten gelir. Repo herkese açık olduğunda uygulama kendini güncellemeye başlar.">
        <Row label={PHASE_TEXT[update.phase]} hint={update.lastChecked ? `Son denetim: ${formatDateTime(update.lastChecked)}` : "Uygulama açıldıktan kısa süre sonra denetlenir."}>
          <div className="flex gap-2">
            {(update.phase === "available" || update.phase === "ready" || update.phase === "downloading") && (
              <Button variant="primary" size="sm" onClick={() => setDialog(true)}>
                v{update.availableVersion}
              </Button>
            )}
            <Button size="sm" icon={RefreshCw} loading={update.phase === "checking"} onClick={() => void updater.check({ quiet: false })}>
              Şimdi denetle
            </Button>
          </div>
        </Row>
        <Row label="Otomatik denetle" hint="Açılışta ve 6 saatte bir sessizce kontrol eder; kurulum her zaman senin onayınla olur.">
          <Toggle label="Otomatik denetle" checked={update.autoCheck} onChange={(next) => updater.setAutoCheck(next)} />
        </Row>
        <Row label="Sürüm notları" hint="Tüm sürümler ve değişiklikler.">
          <Button size="sm" variant="subtle" icon={ExternalLink} onClick={() => void openUrl(RELEASES_URL)}>
            GitHub
          </Button>
        </Row>
      </Card>

      <Card title="Bileşenler">
        <Row label="Motor" hint="Oturumları çalıştıran yerel servis.">
          <span className="font-mono text-[12.5px] text-ink-200">{info?.engineVersion ?? "—"}</span>
        </Row>
        <Row label="Claude Code" hint={info?.claudePath ?? undefined}>
          <span className="font-mono text-[12.5px] text-ink-200">{info?.claudeVersion ?? "—"}</span>
        </Row>
        <Row label="Platform">
          <span className="font-mono text-[12.5px] text-ink-200">{info?.platform ?? "—"}</span>
        </Row>
      </Card>
      <UpdateDialog open={dialog} onClose={() => setDialog(false)} />
    </>
  );
}
