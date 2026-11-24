/** New headless session form: device, profile, directory, prompt and the options behind "Gelişmiş". */
import type { EngineSettings, PermissionMode, WaitPolicy } from "@hub/protocol";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FolderOpen, Rocket, ShieldAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PERMISSION_MODES } from "../lib/format";
import { LOCAL, rpc } from "../lib/ipc";
import { ModelPicker } from "../ui/ModelPicker";
import { hub, useHub } from "../lib/store";
import { Button, Card, Input, Row, SectionHeader, Segmented, Select, TextArea } from "../ui/kit";
import { useToasts } from "../ui/toasts";


type WaitMode = WaitPolicy["mode"] | "inherit";
const WAIT_MODES: ReadonlyArray<{ value: WaitMode; label: string }> = [
  { value: "inherit", label: "Ayarlardaki" },
  { value: "wait", label: "Süresiz bekle" },
  { value: "deny_after", label: "Sonra reddet" },
  { value: "defer_after", label: "Sonra ertele" },
];

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function NewSession() {
  const devices = useHub((state) => state.devices);
  const peers = useHub((state) => state.peers);
  const { push } = useToasts();
  const operableDevices = useMemo(() => {
    const remote = (peers?.hosts ?? []).filter((host) => host.status === "online" && host.access !== "read_only").map((host) => ({ value: host.id, label: host.name }));
    return [{ value: LOCAL, label: devices[LOCAL]?.info?.hostname ? `${devices[LOCAL].info.hostname} (bu cihaz)` : "Bu cihaz" }, ...remote];
  }, [devices, peers]);

  const [device, setDevice] = useState(LOCAL);
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const [profileId, setProfileId] = useState("");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [model, setModel] = useState("");
  const [waitMode, setWaitMode] = useState<WaitMode>("inherit");
  const [waitMinutes, setWaitMinutes] = useState("30");
  const [advanced, setAdvanced] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxTurns, setMaxTurns] = useState("");
  const [maxBudget, setMaxBudget] = useState("");
  const [allowedTools, setAllowedTools] = useState("");
  const [disallowedTools, setDisallowedTools] = useState("");
  const [starting, setStarting] = useState(false);

  // Unsaved input asks before any navigation discards it (Esc, sidebar, settings).
  const dirty = [prompt, name, labels, systemPrompt, allowedTools, disallowedTools].some((value) => value.trim() !== "");
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => hub.setLeaveGuard(() => dirtyRef.current), []);

  useEffect(() => {
    setSettings(null);
    rpc(device, "settings.get", {})
      .then((next) => {
        setSettings(next);
        setProfileId(next.defaultProfileId);
        setPermissionMode(next.defaultPermissionMode);
        setModel(next.defaultModel ?? "");
        setCwd((current) => (current && next.allowedDirectories.some((dir) => current.startsWith(dir)) ? current : (next.allowedDirectories[0] ?? "")));
      })
      .catch((err: unknown) => push("error", err instanceof Error ? err.message : "Ayarlar okunamadı"));
  }, [device, push]);

  const browse = async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: cwd || undefined });
    if (typeof picked === "string") setCwd(picked);
  };

  const outsideAllowlist = settings !== null && cwd !== "" && !settings.allowedDirectories.some((dir) => cwd === dir || cwd.startsWith(`${dir}/`) || cwd.startsWith(`${dir}\\`));

  const allowDirectory = async () => {
    if (!settings) return;
    try {
      const next = await rpc(device, "settings.update", { allowedDirectories: [...settings.allowedDirectories, cwd] });
      setSettings(next);
      push("success", "Dizin izin listesine eklendi");
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Eklenemedi");
    }
  };

  const start = async () => {
    const minutes = Number(waitMinutes);
    const waitPolicy: WaitPolicy | undefined =
      waitMode === "inherit" ? undefined : waitMode === "wait" ? { mode: "wait" } : { mode: waitMode, minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 30 };
    setStarting(true);
    try {
      const session = await rpc(device, "sessions.start", {
        cwd,
        prompt,
        profileId,
        permissionMode,
        labels: splitList(labels),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(waitPolicy ? { waitPolicy } : {}),
        ...(systemPrompt.trim() ? { appendSystemPrompt: systemPrompt.trim() } : {}),
        ...(Number(maxTurns) > 0 ? { maxTurns: Math.round(Number(maxTurns)) } : {}),
        ...(Number(maxBudget) > 0 ? { maxBudgetUsd: Number(maxBudget) } : {}),
        ...(allowedTools.trim() ? { allowedTools: splitList(allowedTools) } : {}),
        ...(disallowedTools.trim() ? { disallowedTools: splitList(disallowedTools) } : {}),
      });
      hub.clearLeaveGuard();
      hub.setView({ kind: "session", device, sessionId: session.id });
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Oturum başlatılamadı");
    } finally {
      setStarting(false);
    }
  };

  const ready = settings !== null && cwd !== "" && prompt.trim() !== "" && !outsideAllowlist;

  return (
    <div className="scroll-quiet h-full overflow-y-auto">
      <div data-tauri-drag-region className="sticky top-0 z-20 h-[54px]" />
      <div className="mx-auto max-w-[760px] px-10 pb-16">
        <SectionHeader title="Yeni oturum" subtitle="Claude Code'u arka planda başlat; soru ya da izin gerektiğinde burada seni bekler." />
        <div className="space-y-4">
          <Card>
            <div className="space-y-4">
              <TextArea
                autoFocus
                rows={6}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && ready) void start();
                }}
                placeholder="Claude ne yapsın? Örn: “Testleri çalıştır, kırılanları düzelt ve bir PR açıklaması yaz.”"
                className="min-h-[140px] text-[14px]"
              />
              <div className="flex gap-2">
                <Input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Çalışma dizini" mono className="flex-1" />
                {device === LOCAL && (
                  <Button icon={FolderOpen} onClick={() => void browse()} className="h-9">
                    Seç
                  </Button>
                )}
              </div>
              <AnimatePresence>
                {outsideAllowlist && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <div className="flex items-center gap-3 rounded-xl border border-beacon-400/30 bg-beacon-400/[0.08] p-3 text-[12.5px] text-beacon-200">
                      <ShieldAlert className="size-4 shrink-0" />
                      <span className="flex-1">Bu dizin izin verilen dizinler listesinde değil. Oturumlar yalnızca senin onayladığın dizinlerde başlar.</span>
                      <Button size="sm" variant="ghost" onClick={() => void allowDirectory()}>
                        Listeye ekle
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </Card>

          <Card>
            {operableDevices.length > 1 && (
              <Row label="Cihaz" hint="Oturum seçtiğin cihazda, o cihazın Claude girişiyle çalışır.">
                <Select label="Cihaz" value={device} options={operableDevices} onChange={setDevice} />
              </Row>
            )}
            <Row label="Claude profili" hint="Hangi Claude Code girişiyle (CLAUDE_CONFIG_DIR) çalışacağı.">
              <Select label="Profil" value={profileId} options={(settings?.profiles ?? []).map((profile) => ({ value: profile.id, label: profile.name }))} onChange={setProfileId} />
            </Row>
            <Row label="Ad" hint="Boş bırakırsan istemin ilk satırı kullanılır.">
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="ör. Gece testleri" className="w-[260px]" />
            </Row>
            <Row label="Etiketler" hint="Virgülle ayır; listede filtrelemek ve webhook'larda ayırt etmek için.">
              <Input value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="ci, backend" className="w-[260px]" />
            </Row>
            <Row label="Model" hint="Varsayılanı Ayarlar → Davranış'tan değiştirebilirsin; oturum çalışırken de değişebilir.">
              <ModelPicker value={model} onChange={setModel} />
            </Row>
            <Row label="Çalışma modu" hint={`${PERMISSION_MODES.find((option) => option.value === permissionMode)?.hint ?? ""} Session Hub izinleri gevşetmez.`}>
              <Select label="Çalışma modu" value={permissionMode} options={PERMISSION_MODES} onChange={setPermissionMode} />
            </Row>
            <Row label="Cevap bekleme" hint="Soru ya da izin cevapsız kalırsa ne olsun.">
              <div className="flex items-center gap-2">
                <Segmented value={waitMode} options={WAIT_MODES} onChange={setWaitMode} size="sm" />
                {(waitMode === "deny_after" || waitMode === "defer_after") && (
                  <Input value={waitMinutes} onChange={(event) => setWaitMinutes(event.target.value.replace(/[^0-9]/g, ""))} className="h-7 w-16 text-center" aria-label="Dakika" />
                )}
              </div>
            </Row>
          </Card>

          <div>
            <button type="button" onClick={() => setAdvanced((value) => !value)} className="flex items-center gap-1.5 px-1 text-[12.5px] text-ink-400 transition-colors hover:text-ink-50">
              <motion.span animate={{ rotate: advanced ? 180 : 0 }}>
                <ChevronDown className="size-3.5" />
              </motion.span>
              Gelişmiş
            </button>
            <AnimatePresence initial={false}>
              {advanced && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
                  <Card className="mt-3">
                    <Row label="En fazla adım" hint="Bu kadar turdan sonra durur.">
                      <Input value={maxTurns} onChange={(event) => setMaxTurns(event.target.value.replace(/[^0-9]/g, ""))} placeholder="sınırsız" className="w-[120px]" />
                    </Row>
                    <Row label="Tahmini bütçe ($)" hint="Tahmini maliyet bu değeri aşınca durur. Abonelikte fatura değildir.">
                      <Input value={maxBudget} onChange={(event) => setMaxBudget(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="sınırsız" className="w-[120px]" />
                    </Row>
                    <Row label="İzinli araçlar" hint="Virgülle; örn. Read, Bash(npm test:*).">
                      <Input value={allowedTools} onChange={(event) => setAllowedTools(event.target.value)} className="w-[280px]" mono />
                    </Row>
                    <Row label="Yasaklı araçlar" hint="Virgülle; bu araçlar hiç kullanılamaz.">
                      <Input value={disallowedTools} onChange={(event) => setDisallowedTools(event.target.value)} className="w-[280px]" mono />
                    </Row>
                    <div className="border-t border-white/[0.05] pt-3.5">
                      <div className="text-[13.5px] font-medium">Ek sistem istemi</div>
                      <div className="mt-0.5 mb-2 text-[12.5px] text-ink-400">Claude Code'un kendi sistem isteminin sonuna eklenir.</div>
                      <TextArea rows={3} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} />
                    </div>
                  </Card>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <span className="text-[11.5px] text-ink-500">⌘/Ctrl + Enter</span>
            <Button variant="primary" size="lg" icon={Rocket} loading={starting} disabled={!ready} onClick={() => void start()}>
              Başlat
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
