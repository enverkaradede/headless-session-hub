/** General: Claude profiles, allowed directories, CLI path, login auto-start and auth status. */
import type { AuthState, ClaudeProfile, EngineSettings } from "@hub/protocol";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderPlus, KeyRound, Plus, Power, RefreshCw, Star, Terminal, Trash2, UserRound } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { LOCAL, rpc } from "../../lib/ipc";
import { useHub } from "../../lib/store";
import { Button, Card, Chip, Input, Row, TextField, Toggle } from "../../ui/kit";
import { useToasts } from "../../ui/toasts";

interface SectionProps {
  device: string;
  settings: EngineSettings;
  update: (patch: Partial<EngineSettings>, success?: string) => Promise<unknown>;
}

const AUTH_TONE: Record<AuthState["method"], "jade" | "rose" | "beacon" | "neutral"> = {
  subscription: "jade",
  api_key: "beacon",
  third_party: "beacon",
  not_logged_in: "rose",
  unknown: "neutral",
};

function slug(name: string): string {
  const base = name
    .toLocaleLowerCase("tr")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "profil";
}

export function GeneralSection({ device, settings, update }: SectionProps) {
  const info = useHub((state) => state.devices[device]?.info ?? null);
  const { push } = useToasts();
  const [refreshing, setRefreshing] = useState(false);
  const [newProfile, setNewProfile] = useState<{ name: string; configDir: string } | null>(null);

  const refreshAuth = async () => {
    setRefreshing(true);
    try {
      await rpc(device, "auth.refresh", {});
      push("success", "Giriş durumu yenilendi");
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Yenilenemedi");
    } finally {
      setRefreshing(false);
    }
  };

  const addDirectory = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string" || settings.allowedDirectories.includes(picked)) return;
    await update({ allowedDirectories: [...settings.allowedDirectories, picked] }, "Dizin eklendi");
  };

  const saveProfile = async () => {
    if (!newProfile || !newProfile.name.trim()) return;
    let id = slug(newProfile.name);
    while (settings.profiles.some((profile) => profile.id === id)) id = `${id}-2`;
    const profile: ClaudeProfile = { id, name: newProfile.name.trim(), configDir: newProfile.configDir.trim() || null };
    await update({ profiles: [...settings.profiles, profile] }, "Profil eklendi");
    setNewProfile(null);
  };

  const removeProfile = (id: string) => update({ profiles: settings.profiles.filter((profile) => profile.id !== id) }, "Profil kaldırıldı");
  const authFor = (id: string) => info?.auth.find((state) => state.profileId === id) ?? null;

  return (
    <>
      <Card
        title="Claude profilleri"
        icon={UserRound}
        description="Her profil ayrı bir Claude Code girişidir (CLAUDE_CONFIG_DIR). Oturumlar sadece abonelik girişiyle başlar."
        actions={
          <Button size="sm" icon={RefreshCw} loading={refreshing} onClick={() => void refreshAuth()}>
            Girişleri kontrol et
          </Button>
        }
      >
        <div className="space-y-2">
          {settings.profiles.map((profile) => {
            const auth = authFor(profile.id);
            const isDefault = settings.defaultProfileId === profile.id;
            return (
              <div key={profile.id} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-harbor-950/40 px-3.5 py-2.5">
                <button
                  type="button"
                  aria-label="Varsayılan yap"
                  title={isDefault ? "Varsayılan profil" : "Varsayılan yap"}
                  onClick={() => !isDefault && void update({ defaultProfileId: profile.id }, "Varsayılan profil değişti")}
                  className={isDefault ? "text-beacon-300" : "text-ink-500 hover:text-beacon-200"}
                >
                  <Star className="size-4" fill={isDefault ? "currentColor" : "none"} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">{profile.name}</div>
                  <div className="truncate font-mono text-[11.5px] text-ink-500">{profile.configDir ?? "~/.claude (varsayılan)"}</div>
                </div>
                {auth && <Chip tone={AUTH_TONE[auth.method]}>{auth.detail}</Chip>}
                {!isDefault && (
                  <Button size="sm" variant="subtle" icon={Trash2} aria-label="Kaldır" onClick={() => void removeProfile(profile.id)} />
                )}
              </div>
            );
          })}
          <AnimatePresence initial={false}>
            {newProfile ? (
              <motion.div key="form" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="flex items-center gap-2 pt-1">
                  <Input autoFocus value={newProfile.name} onChange={(event) => setNewProfile({ ...newProfile, name: event.target.value })} placeholder="Ad, ör. Kişisel" className="w-40" />
                  <Input value={newProfile.configDir} onChange={(event) => setNewProfile({ ...newProfile, configDir: event.target.value })} placeholder="~/.claude-personal (boş: varsayılan)" mono className="flex-1" />
                  <Button variant="primary" onClick={() => void saveProfile()} disabled={!newProfile.name.trim()}>
                    Ekle
                  </Button>
                  <Button variant="subtle" onClick={() => setNewProfile(null)}>
                    Vazgeç
                  </Button>
                </div>
              </motion.div>
            ) : (
              <Button key="add" size="sm" variant="subtle" icon={Plus} onClick={() => setNewProfile({ name: "", configDir: "" })}>
                Profil ekle
              </Button>
            )}
          </AnimatePresence>
        </div>
      </Card>

      <Card
        title="İzin verilen dizinler"
        icon={FolderPlus}
        description="Oturumlar yalnızca bu dizinlerde ve altlarında başlar. Uzak cihazlar da bu listeyle sınırlıdır."
        actions={
          device === LOCAL ? (
            <Button size="sm" icon={Plus} onClick={() => void addDirectory()}>
              Dizin ekle
            </Button>
          ) : null
        }
      >
        {settings.allowedDirectories.length === 0 ? (
          <p className="text-[12.5px] text-ink-500">Henüz dizin yok. Bir proje klasörü ekle; oturumlar ancak o zaman başlayabilir.</p>
        ) : (
          <ul className="space-y-1.5">
            <AnimatePresence initial={false}>
              {settings.allowedDirectories.map((dir) => (
                <motion.li key={dir} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 20 }} className="flex items-center gap-2 rounded-lg bg-harbor-950/40 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-200">{dir}</span>
                  <Button size="sm" variant="subtle" icon={Trash2} aria-label="Kaldır" onClick={() => void update({ allowedDirectories: settings.allowedDirectories.filter((item) => item !== dir) }, "Dizin kaldırıldı")} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Card>

      <Card title="Claude Code" icon={Terminal}>
        <Row label="Sürüm" hint={info?.claudePath ? <span className="font-mono">{info.claudePath}</span> : "Kurulu Claude Code bulunamadı."}>
          <span className="font-mono text-[12.5px] text-ink-200">{info?.claudeVersion ?? "—"}</span>
        </Row>
        <Row label="Çalıştırılabilir dosya yolu" hint="Boş bırakırsan otomatik bulunur. Windows'ta .cmd kısayolu değil, gerçek claude.exe olmalı.">
          <TextField label="Claude yolu" value={settings.claudePath ?? ""} onCommit={(value) => void update({ claudePath: value.trim() || null }, "Yol kaydedildi")} placeholder="otomatik" mono className="w-[280px]" />
        </Row>
        {device === LOCAL && <AutostartRow />}
      </Card>

      {device === LOCAL && info?.auth.some((auth) => auth.method === "not_logged_in") && (
        <p className="flex items-center gap-2 px-1 text-[12.5px] text-beacon-200">
          <KeyRound className="size-4" /> Giriş yapılmamış profil var: terminalde o profille <span className="font-mono">claude</span> çalıştırıp giriş yap.
        </p>
      )}
    </>
  );
}

function AutostartRow() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const { push } = useToasts();
  useEffect(() => {
    isEnabled()
      .then(setEnabled)
      .catch(() => setEnabled(false));
  }, []);
  const change = async (next: boolean) => {
    setEnabled(next);
    try {
      await (next ? enable() : disable());
    } catch (err) {
      setEnabled(!next);
      push("error", err instanceof Error ? err.message : "Değiştirilemedi");
    }
  };
  return (
    <Row label="Girişte başlat" hint="Bilgisayar açılınca tepside sessizce başlar; zamanlanmış oturumlar ve uzak cihazlar onu bulabilir.">
      <div className="flex items-center gap-2">
        <Power className="size-3.5 text-ink-500" />
        <Toggle label="Girişte başlat" checked={enabled ?? false} disabled={enabled === null} onChange={(next) => void change(next)} />
      </div>
    </Row>
  );
}
