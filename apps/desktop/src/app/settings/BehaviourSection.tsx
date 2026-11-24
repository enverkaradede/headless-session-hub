/** Behaviour: wait policy, warm processes, usage-limit protection, auth guard, privacy and retention. */
import type { EngineSettings, WaitPolicy } from "@hub/protocol";
import { Clock, Cpu, EyeOff, ShieldAlert, Timer } from "lucide-react";
import { PERMISSION_MODES } from "../../lib/format";
import { Card, Row, Segmented, Select, TextField, Toggle } from "../../ui/kit";
import { ModelPicker } from "../../ui/ModelPicker";

interface SectionProps {
  device: string;
  settings: EngineSettings;
  update: (patch: Partial<EngineSettings>, success?: string) => Promise<unknown>;
}

const WAIT_OPTIONS: ReadonlyArray<{ value: WaitPolicy["mode"]; label: string }> = [
  { value: "wait", label: "Süresiz bekle" },
  { value: "deny_after", label: "Sonra reddet" },
  { value: "defer_after", label: "Sonra ertele" },
];
const DEFAULT_WAIT_MINUTES = 30;

function toInt(value: string, min: number, max: number): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function BehaviourSection({ settings, update }: SectionProps) {
  const policy = settings.defaultWaitPolicy;
  const minutes = policy.mode === "wait" ? DEFAULT_WAIT_MINUTES : policy.minutes;
  const setPolicy = (mode: WaitPolicy["mode"], nextMinutes = minutes) =>
    void update({ defaultWaitPolicy: mode === "wait" ? { mode } : { mode, minutes: nextMinutes } }, "Bekleme politikası kaydedildi");

  const mode = PERMISSION_MODES.find((option) => option.value === settings.defaultPermissionMode) ?? PERMISSION_MODES[0];
  return (
    <>
      <Card title="Oturum varsayılanları" icon={Cpu} description="Yeni oturumlar bunlarla başlar; her oturumda ve çalışırken ayrıca değiştirilebilir.">
        <Row label="Model" hint="Profil varsayılanı: o Claude girişinin kendi ayarındaki model.">
          <ModelPicker value={settings.defaultModel ?? ""} onChange={(next) => void update({ defaultModel: next || null }, "Varsayılan model kaydedildi")} />
        </Row>
        <Row label="Çalışma modu" hint={mode?.hint}>
          <Select label="Çalışma modu" value={settings.defaultPermissionMode} options={PERMISSION_MODES} onChange={(next) => void update({ defaultPermissionMode: next }, "Varsayılan mod kaydedildi")} />
        </Row>
        <Row label="Soruları kart olarak sor" hint="Claude'dan sorularını AskUserQuestion ile sormasını ister; seçenekli kart olarak gelir. claude -p oturumlarında bu araç yoktur, orada düz metin soru algılanır.">
          <Toggle label="Soruları kart olarak sor" checked={settings.askViaTool} onChange={(next) => void update({ askViaTool: next })} />
        </Row>
      </Card>

      <Card title="Cevap bekleme" icon={Clock} description="Bir oturum soru sorduğunda ya da izin istediğinde sen cevap verene kadar ne olacağı. Oturum bazında değiştirilebilir.">
        <Row
          label="Varsayılan politika"
          hint={
            policy.mode === "wait"
              ? "Süreç açık kalır ve seni bekler."
              : policy.mode === "deny_after"
                ? "Süre dolunca istek reddedilir; Claude ret mesajıyla devam eder."
                : "Süre dolunca süreç kapanır. Cevap verdiğinde oturum geçmişiyle birlikte kaldığı yerden devam eder."
          }
        >
          <Segmented value={policy.mode} options={WAIT_OPTIONS} onChange={(mode) => setPolicy(mode)} size="sm" />
        </Row>
        {policy.mode !== "wait" && (
          <Row label="Süre (dakika)" hint="1 dakika ile 7 gün arası.">
            <TextField
              label="Dakika"
              value={String(minutes)}
              onCommit={(value) => {
                const next = toInt(value, 1, 10_080);
                if (next !== null) setPolicy(policy.mode, next);
              }}
              className="w-20 text-center"
            />
          </Row>
        )}
      </Card>

      <Card title="Süreçler ve limitler" icon={Timer}>
        <Row label="Biten oturumu sıcak tut (dakika)" hint="Bu süre içinde gönderilen mesaj anında işlenir; sonra süreç kapanır ve mesaj --resume ile devam eder. 0 = hemen kapat.">
          <TextField
            label="Dakika"
            value={String(settings.warmIdleMinutes)}
            onCommit={(value) => {
              const next = toInt(value, 0, 240);
              if (next !== null) void update({ warmIdleMinutes: next }, "Kaydedildi");
            }}
            className="w-20 text-center"
          />
        </Row>
        <Row label="Ücretli krediye geçince durdur" hint="Abonelikte 'usage credits' açıksa limit aşımı ücretli devam eder. Açıkken oturum duraklar ve kararını bekler.">
          <Toggle label="Ücretli krediye geçince durdur" checked={settings.pauseOnOverage} onChange={(next) => void update({ pauseOnOverage: next })} />
        </Row>
        <Row label="Olay saklama süresi (gün)" hint="Bu süreden eski zaman çizelgesi kayıtları silinir. Oturum özetleri kalır.">
          <TextField
            label="Gün"
            value={String(settings.eventRetentionDays)}
            onCommit={(value) => {
              const next = toInt(value, 1, 3650);
              if (next !== null) void update({ eventRetentionDays: next }, "Kaydedildi");
            }}
            className="w-20 text-center"
          />
        </Row>
      </Card>

      <Card title="Gizlilik" icon={EyeOff}>
        <Row label="Uzak cihazlara sadece özet gönder" hint="Açıkken eşleşen cihazlar komutları, dosya içeriklerini ve model metnini görmez; sadece durum, istek ve sonuçlar gider. Gizli bilgiler her durumda maskelenir.">
          <Toggle label="Sadece özet gönder" checked={settings.summaryOnlyForPeers} onChange={(next) => void update({ summaryOnlyForPeers: next })} />
        </Row>
      </Card>

      <Card title="Faturalama koruması" icon={ShieldAlert}>
        <Row
          label="Abonelik dışı girişe izin ver"
          hint="Kapalıyken API anahtarı, Bedrock ya da Vertex ile çalışacak oturumlar başlatılmaz ve ANTHROPIC_API_KEY oturumlara aktarılmaz. Bunu sadece bilerek aç."
        >
          <Toggle label="Abonelik dışı girişe izin ver" checked={settings.allowNonSubscriptionAuth} onChange={(next) => void update({ allowNonSubscriptionAuth: next }, next ? "Abonelik dışı girişlere izin verildi" : "Sadece abonelik girişi")} />
        </Row>
      </Card>
    </>
  );
}
