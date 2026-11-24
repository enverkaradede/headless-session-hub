/**
 * App updates: signed artifacts from GitHub Releases (latest.json), checked quietly at start and every
 * few hours. While the repository is private the endpoint is unreachable; that is "no update", not an error.
 */
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";

const FIRST_CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_CHECK_KEY = "session-hub.autoUpdateCheck";
export const RELEASES_URL = "https://github.com/enverkaradede/headless-session-hub/releases";

export type UpdatePhase = "idle" | "checking" | "up_to_date" | "available" | "downloading" | "ready" | "unreachable" | "error";

export interface UpdateState {
  currentVersion: string | null;
  phase: UpdatePhase;
  availableVersion: string | null;
  notes: string | null;
  /** 0..1 while downloading. */
  progress: number;
  error: string | null;
  lastChecked: number | null;
  autoCheck: boolean;
}

type Listener = () => void;

class Updater {
  private state: UpdateState = {
    currentVersion: null,
    phase: "idle",
    availableVersion: null,
    notes: null,
    progress: 0,
    error: null,
    lastChecked: null,
    autoCheck: localStorage.getItem(AUTO_CHECK_KEY) !== "false",
  };
  private readonly listeners = new Set<Listener>();
  private pending: Update | null = null;
  private timer: number | null = null;
  private started = false;

  getState = (): UpdateState => this.state;
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void getVersion().then((currentVersion) => this.set({ currentVersion }));
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (!this.state.autoCheck) return;
    const delay = this.state.lastChecked === null ? FIRST_CHECK_DELAY_MS : CHECK_INTERVAL_MS;
    this.timer = window.setTimeout(() => {
      void this.check({ quiet: true }).finally(() => this.schedule());
    }, delay);
  }

  setAutoCheck(enabled: boolean): void {
    localStorage.setItem(AUTO_CHECK_KEY, String(enabled));
    this.set({ autoCheck: enabled });
    this.schedule();
  }

  /** Quiet checks swallow network failures (private repo, offline) instead of surfacing an error. */
  async check({ quiet }: { quiet: boolean }): Promise<void> {
    if (this.state.phase === "downloading" || this.state.phase === "ready") return;
    this.set({ phase: "checking", error: null });
    try {
      const update = await check();
      this.pending = update;
      this.set(
        update
          ? { phase: "available", availableVersion: update.version, notes: update.body ?? null, lastChecked: Date.now() }
          : { phase: "up_to_date", availableVersion: null, notes: null, lastChecked: Date.now() },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.set({ phase: quiet ? "unreachable" : "error", error: message, lastChecked: Date.now() });
    }
  }

  async install(): Promise<void> {
    const update = this.pending;
    if (!update) return;
    let total = 0;
    let received = 0;
    this.set({ phase: "downloading", progress: 0, error: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          received += event.data.chunkLength;
          this.set({ progress: total > 0 ? Math.min(1, received / total) : 0 });
        }
        if (event.event === "Finished") this.set({ progress: 1 });
      });
      this.set({ phase: "ready" });
    } catch (err) {
      this.set({ phase: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  relaunch(): Promise<void> {
    return relaunch();
  }
}

export const updater = new Updater();

export function useUpdater(): UpdateState {
  return useSyncExternalStore(updater.subscribe, updater.getState);
}
