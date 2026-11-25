/** Display helpers and Turkish copy for statuses. Kept in one place so the UI can be localised later. */
import type { PeerAccess, PermissionMode, SessionStatus } from "@hub/protocol";
import type { Tone } from "../ui/kit";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: "Başlıyor",
  running: "Çalışıyor",
  waiting_input: "Cevabını bekliyor",
  waiting_permission: "İzin bekliyor",
  idle: "Boşta",
  done: "Bitti",
  error: "Hata",
  usage_limit: "Limit doldu",
  deferred: "Ertelendi",
};

export const STATUS_TONE: Record<SessionStatus, Tone> = {
  starting: "busy",
  running: "busy",
  waiting_input: "attention",
  waiting_permission: "attention",
  idle: "idle",
  done: "ok",
  error: "error",
  usage_limit: "error",
  deferred: "deferred",
};

/** Statuses that need the owner; pinned to the top of the list. Mirrors ATTENTION_STATUSES in the protocol. */
export const ATTENTION: ReadonlySet<SessionStatus> = new Set(["waiting_input", "waiting_permission", "usage_limit", "deferred"]);

export const ACCESS_LABEL: Record<PeerAccess, string> = {
  read_only: "Salt okunur",
  operator: "Operatör",
  full: "Tam yetkili",
};

export const ACCESS_HINT: Record<PeerAccess, string> = {
  read_only: "Oturumları ve kayıtları görür; hiçbir şeyi değiştiremez, cevap veremez.",
  operator: "Oturum başlatır, mesaj gönderir, soru ve izinleri cevaplar, durdurur. Ayarlara dokunamaz.",
  full: "Operatörün yaptıklarına ek olarak ayarları, dizinleri ve hook'ları da değiştirebilir.",
};

const relative = new Intl.RelativeTimeFormat("tr", { numeric: "auto" });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function timeAgo(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return "şimdi";
  if (abs < HOUR) return relative.format(Math.round(diff / MINUTE), "minute");
  if (abs < DAY) return relative.format(Math.round(diff / HOUR), "hour");
  return relative.format(Math.round(diff / DAY), "day");
}

const clock = new Intl.DateTimeFormat("tr", { hour: "2-digit", minute: "2-digit" });
const dateTime = new Intl.DateTimeFormat("tr", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const formatClock = (ts: number) => clock.format(ts);
export const formatDateTime = (ts: number) => dateTime.format(ts);

export function formatCost(usd: number): string {
  if (usd === 0) return "—";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Last path segment, for compact project labels. Works for Windows and POSIX paths. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** SDK reset timestamps are not documented as seconds or milliseconds; accept both. */
export function epochToMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

/** Model choices offered everywhere; "" means "the profile's own default". Any other id can be typed. */
export const MODEL_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Profil varsayılanı" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/**
 * The preset a model value belongs to. Running sessions report full ids ("claude-haiku-5-5", "claude-opus-5-5[1m]");
 * those map to their family so the picker shows "Haiku" instead of a custom id. Null means a truly custom model.
 */
export function modelPreset(value: string): string | null {
  if (MODEL_PRESETS.some((preset) => preset.value === value)) return value;
  const family = /^claude-(opus|sonnet|haiku)(?:-|$)/i.exec(value.trim())?.[1]?.toLowerCase();
  return family && MODEL_PRESETS.some((preset) => preset.value === family) ? family : null;
}

export const PERMISSION_MODES: ReadonlyArray<{ value: PermissionMode; label: string; hint: string }> = [
  { value: "auto", label: "Otomatik", hint: "Bir sınıflandırıcı güvenli adımları onaylar, riskliler sorulur." },
  { value: "default", label: "Sor (manuel)", hint: "İzin gerektiren her adım sana sorulur." },
  { value: "acceptEdits", label: "Düzenlemeleri kabul et", hint: "Dosya düzenlemeleri otomatik; komutlar yine sorulur." },
  { value: "plan", label: "Plan", hint: "Sadece plan çıkarır, hiçbir şey çalıştırmaz." },
  { value: "dontAsk", label: "Sorma", hint: "İzinli olmayan her adımı reddeder; hiç soru gelmez." },
];

/**
 * The terminal command that opens Claude Code under a profile's config folder, to log that profile in. The full
 * executable path is used when known, since `claude` itself may be aliased or missing from PATH.
 */
export function loginCommand(configDir: string | null, platform: string, claudePath: string | null = null): string {
  if (platform === "win32") {
    const exe = claudePath ? `& "${claudePath}"` : "claude";
    return configDir ? `$env:CLAUDE_CONFIG_DIR="${configDir}"; ${exe}` : exe;
  }
  const exe = claudePath ? (/\s/.test(claudePath) ? `"${claudePath}"` : claudePath) : "claude";
  // Quoting would stop "~" from expanding, so only folders with spaces are quoted.
  const dir = configDir && /\s/.test(configDir) ? `"${configDir}"` : configDir;
  return dir ? `CLAUDE_CONFIG_DIR=${dir} ${exe}` : exe;
}
