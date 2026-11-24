/** Client-side state for every device's sessions, fed by RPC snapshots and pushed engine events. */
import { useSyncExternalStore } from "react";
import type { EngineEvent, EngineInfo, PendingRequest, SessionSummary, TimelineEvent } from "@hub/protocol";
import { LOCAL, onEngineEvent, onEngineStatus, onPeersChanged, rpc, shell, type DeviceEvent, type EngineStatus, type PeersState } from "./ipc";

const TIMELINE_PAGE = 2000;

export interface DeviceState {
  key: string;
  name: string;
  online: boolean;
  info: EngineInfo | null;
  sessions: Record<string, SessionSummary>;
  /** Open (and recently closed) requests per session. */
  requests: Record<string, PendingRequest[]>;
  loadError: string | null;
}

export type View = { kind: "session"; device: string; sessionId: string } | { kind: "new" } | { kind: "settings" } | { kind: "home" };

export interface HubState {
  engine: EngineStatus;
  peers: PeersState | null;
  devices: Record<string, DeviceState>;
  timelines: Record<string, TimelineEvent[]>;
  view: View;
}

export const timelineKey = (device: string, sessionId: string) => `${device}::${sessionId}`;

type Listener = () => void;

class HubStore {
  private state: HubState = {
    engine: { state: "starting" },
    peers: null,
    devices: { [LOCAL]: emptyDevice(LOCAL, "Bu cihaz", false) },
    timelines: {},
    view: { kind: "home" },
  };
  private readonly listeners = new Set<Listener>();
  private started = false;

  getState = (): HubState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<HubState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  private patchDevice(key: string, change: (device: DeviceState) => DeviceState): void {
    const current = this.state.devices[key];
    if (!current) return;
    this.set({ devices: { ...this.state.devices, [key]: change(current) } });
  }

  setView(view: View): void {
    this.set({ view });
    if (view.kind === "session") void this.loadSession(view.device, view.sessionId);
  }

  /** Wires shell events once and loads the initial snapshot. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await Promise.all([
      onEngineEvent((payload) => this.onEvent(payload)),
      onEngineStatus((status) => this.onEngineStatus(status)),
      onPeersChanged((peers) => this.onPeers(peers)),
    ]);
    this.onEngineStatus(await shell.engineStatus());
    this.onPeers(await shell.peersState());
  }

  private onEngineStatus(engine: EngineStatus): void {
    this.set({ engine });
    const ready = engine.state === "ready";
    this.patchDevice(LOCAL, (device) => ({ ...device, online: ready, info: ready ? engine.info : device.info }));
    if (ready) void this.refreshDevice(LOCAL);
  }

  private onPeers(peers: PeersState): void {
    const devices: Record<string, DeviceState> = { [LOCAL]: this.state.devices[LOCAL] ?? emptyDevice(LOCAL, "Bu cihaz", false) };
    const becameOnline: string[] = [];
    for (const host of peers.hosts) {
      const previous = this.state.devices[host.id];
      const online = host.status === "online";
      devices[host.id] = { ...(previous ?? emptyDevice(host.id, host.name, online)), name: host.name, online };
      if (online && !previous?.online) becameOnline.push(host.id);
    }
    this.set({ peers, devices });
    for (const key of becameOnline) void this.refreshDevice(key);
  }

  /** Full refetch of a device's sessions and open requests (startup, reconnect, resync). */
  async refreshDevice(key: string): Promise<void> {
    try {
      const [sessions, info] = await Promise.all([rpc(key, "sessions.list", {}), rpc(key, "engine.info", {})]);
      const waiting = sessions.filter((session) => session.openRequests > 0);
      const requestLists = await Promise.all(waiting.map((session) => rpc(key, "sessions.requests", { sessionId: session.id })));
      const requests: Record<string, PendingRequest[]> = {};
      waiting.forEach((session, index) => (requests[session.id] = requestLists[index] ?? []));
      this.patchDevice(key, (device) => ({
        ...device,
        info,
        loadError: null,
        sessions: Object.fromEntries(sessions.map((session) => [session.id, session])),
        requests: { ...device.requests, ...requests },
      }));
    } catch (err) {
      this.patchDevice(key, (device) => ({ ...device, loadError: err instanceof Error ? err.message : "Yüklenemedi" }));
    }
  }

  /** Loads the timeline and requests of the opened session. */
  async loadSession(device: string, sessionId: string): Promise<void> {
    const key = timelineKey(device, sessionId);
    const [events, requests] = await Promise.all([
      rpc(device, "sessions.timeline", { sessionId, afterSeq: 0, limit: TIMELINE_PAGE }),
      rpc(device, "sessions.requests", { sessionId }),
    ]);
    this.set({ timelines: { ...this.state.timelines, [key]: events } });
    this.patchDevice(device, (state) => ({ ...state, requests: { ...state.requests, [sessionId]: requests } }));
  }

  private onEvent({ device, event }: DeviceEvent): void {
    if (event.type === "resync") {
      void this.refreshDevice(device);
      return;
    }
    this.apply(device, event);
  }

  private apply(device: string, event: EngineEvent): void {
    switch (event.type) {
      case "session.upsert":
        this.patchDevice(device, (state) => ({ ...state, sessions: { ...state.sessions, [event.session.id]: event.session } }));
        return;
      case "session.timeline": {
        const key = timelineKey(device, event.event.sessionId);
        const current = this.state.timelines[key];
        if (!current) return; // not opened yet; loaded on demand
        if (current.some((existing) => existing.seq === event.event.seq)) return;
        this.set({ timelines: { ...this.state.timelines, [key]: [...current, event.event] } });
        return;
      }
      case "request.upsert":
        this.patchDevice(device, (state) => {
          const list = state.requests[event.request.sessionId] ?? [];
          const next = list.some((request) => request.id === event.request.id)
            ? list.map((request) => (request.id === event.request.id ? event.request : request))
            : [...list, event.request];
          return { ...state, requests: { ...state.requests, [event.request.sessionId]: next } };
        });
        return;
      case "engine.status":
        this.patchDevice(device, (state) => ({ ...state, info: event.info }));
        return;
      case "notify":
        return; // native notifications are shown by the shell
    }
  }
}

function emptyDevice(key: string, name: string, online: boolean): DeviceState {
  return { key, name, online, info: null, sessions: {}, requests: {}, loadError: null };
}

export const hub = new HubStore();

export function useHub<T>(selector: (state: HubState) => T): T {
  return useSyncExternalStore(hub.subscribe, () => selector(hub.getState()));
}
