/** Settings of one device's engine: optimistic, serialized saves that roll back on rejection. */
import type { EngineSettings } from "@hub/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/ipc";
import { useToasts } from "../../ui/toasts";

export function useEngineSettings(device: string) {
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const confirmed = useRef<EngineSettings | null>(null);
  const { push } = useToasts();

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError(null);
    rpc(device, "settings.get", {})
      .then((loaded) => {
        if (cancelled) return;
        confirmed.current = loaded;
        setSettings(loaded);
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "Ayarlar okunamadı"));
    return () => {
      cancelled = true;
    };
  }, [device]);

  const update = useCallback(
    (patch: Partial<EngineSettings>, success?: string) => {
      setSettings((current) => (current ? { ...current, ...patch } : current));
      chain.current = chain.current.then(async () => {
        try {
          const saved = await rpc(device, "settings.update", patch);
          confirmed.current = saved;
          setSettings(saved);
          if (success) push("success", success);
        } catch (err) {
          setSettings(confirmed.current);
          push("error", err instanceof Error ? err.message : "Kaydedilemedi");
        }
      });
      return chain.current;
    },
    [device, push],
  );

  return { settings, error, update };
}
