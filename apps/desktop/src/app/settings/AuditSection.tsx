/** Audit log: who answered, started, stopped or changed what, newest first. */
import type { AuditEntry } from "@hub/protocol";
import { ClipboardList, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "../../lib/format";
import { rpc } from "../../lib/ipc";
import { Button, Card, Chip } from "../../ui/kit";

const ACTION_LABEL: Record<string, string> = {
  "session.start": "Oturum başlattı",
  "session.message": "Mesaj gönderdi",
  "session.stop": "Durdurdu",
  "session.update": "Düzenledi",
  "session.observe": "claude -p oturumu kaydedildi",
  "session.auth_blocked": "Giriş yöntemi engellendi",
  "request.answer": "Cevap verdi",
  "request.preapproved_used": "Ön onay kullanıldı",
  "settings.update": "Ayarları değiştirdi",
  "hooks.install": "Hook kurdu",
  "hooks.uninstall": "Hook kaldırdı",
  "rpc.forbidden": "Yetkisiz deneme",
};

function actorLabel(actor: string): { text: string; tone: "neutral" | "beacon" | "rose" } {
  if (actor === "local-ui") return { text: "Bu cihaz", tone: "neutral" };
  if (actor === "local-api") return { text: "Yerel API", tone: "neutral" };
  if (actor.startsWith("peer:")) return { text: actor.slice(5).replace(/#.*\(/, " (").replace(/\)$/, ")"), tone: "beacon" };
  return { text: actor, tone: "neutral" };
}

export function AuditSection({ device }: { device: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    rpc(device, "audit.list", { limit: 300 })
      .then(setEntries)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Okunamadı"));
  }, [device]);
  useEffect(load, [load]);

  return (
    <Card
      title="Denetim kaydı"
      icon={ClipboardList}
      description="Her cevap, başlatma, durdurma ve ayar değişikliği kim / ne zaman / hangi oturum bilgisiyle kaydedilir."
      actions={
        <Button size="sm" icon={RefreshCw} onClick={load}>
          Yenile
        </Button>
      }
    >
      {error ? (
        <p className="text-[12.5px] text-rose-glow">{error}</p>
      ) : entries === null ? (
        <div className="grid h-24 place-items-center text-ink-400">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-[12.5px] text-ink-500">Henüz kayıt yok.</p>
      ) : (
        <ul className="divide-y divide-white/[0.05]">
          {entries.map((entry) => {
            const actor = actorLabel(entry.actor);
            return (
              <li key={entry.id} className="flex items-center gap-3 py-2.5 text-[12.5px]">
                <span className="w-28 shrink-0 text-ink-500 tabular-nums">{formatDateTime(entry.ts)}</span>
                <Chip tone={entry.action === "rpc.forbidden" || entry.action === "session.auth_blocked" ? "rose" : actor.tone}>{actor.text}</Chip>
                <span className="text-ink-200">{ACTION_LABEL[entry.action] ?? entry.action}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-500">{entry.detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
