/** Engine settings with validation; persisted in SQLite. */
import path from "node:path";
import { EngineSettings, type EngineSettings as Settings } from "@hub/protocol";
import type { Store } from "./db.ts";
import { EngineError } from "./errors.ts";

const REDACTED_SECRET = "[REDACTED]******";

export class SettingsService {
  private current: Settings;

  constructor(private readonly store: Store) {
    this.current = store.loadSettings();
  }

  get(): Settings {
    return this.current;
  }

  update(patch: Partial<Settings>): Settings {
    const parsed = EngineSettings.safeParse({ ...this.current, ...patch });
    if (!parsed.success) {
      throw new EngineError("BAD_REQUEST", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }
    const settings = parsed.data;
    for (const dir of settings.allowedDirectories) {
      if (!path.isAbsolute(dir)) throw new EngineError("BAD_REQUEST", `Allowed directory must be absolute: ${dir}`);
    }
    const ids = new Set(settings.profiles.map((profile) => profile.id));
    if (ids.size !== settings.profiles.length) throw new EngineError("BAD_REQUEST", "Profile ids must be unique");
    if (!ids.has(settings.defaultProfileId)) throw new EngineError("BAD_REQUEST", "Default profile must exist");
    if (settings.claudePath && !path.isAbsolute(settings.claudePath)) throw new EngineError("BAD_REQUEST", "Claude path must be absolute");
    for (const hook of settings.webhooks) {
      const protocol = new URL(hook.url).protocol;
      if (protocol !== "https:" && protocol !== "http:") throw new EngineError("BAD_REQUEST", "Webhook URLs must be http(s)");
    }
    // A redacted secret coming back from the UI means "unchanged".
    const webhooks = settings.webhooks.map((hook) =>
      hook.secret === REDACTED_SECRET ? { ...hook, secret: this.current.webhooks.find((old) => old.id === hook.id)?.secret ?? hook.secret } : hook,
    );
    const next = { ...settings, webhooks };
    this.store.saveSettings(next);
    this.current = next;
    return next;
  }

  /** Settings as shown outside the local engine: webhook secrets never leave it. */
  redacted(): Settings {
    return { ...this.current, webhooks: this.current.webhooks.map((hook) => ({ ...hook, secret: REDACTED_SECRET })) };
  }
}
