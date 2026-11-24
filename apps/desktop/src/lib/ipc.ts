/** Typed bridge to the Rust shell: engine RPC (local or a paired device), P2P commands, events. */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EngineEvent, PeerAccess, RpcMethod, RpcParams, RpcResults } from "@hub/protocol";

export const LOCAL = "local";

export class HubError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HubError";
    this.code = code;
  }
}

function toHubError(err: unknown): HubError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return new HubError(String((err as { code: unknown }).code), String((err as { message: unknown }).message));
  }
  return new HubError("UNKNOWN", typeof err === "string" ? err : "Beklenmeyen hata");
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toHubError(err);
  }
}

/** Calls the engine of `device` ("local" or a paired host id). */
export function rpc<M extends RpcMethod>(device: string, method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  return call<RpcResults[M]>("engine_rpc", { device, method, params });
}

export type EngineStatus =
  | { state: "starting" }
  | { state: "ready"; info: RpcResults["engine.info"] }
  | { state: "restarting"; attempt: number; delay_ms: number; reason: string };

export type LinkStatus = "connecting" | "online" | "offline";

export interface ClientDevice {
  id: string;
  name: string;
  access: PeerAccess;
  pairedAt: number;
  connected: boolean;
}

export interface HostDevice {
  id: string;
  name: string;
  access: PeerAccess;
  pairedAt: number;
  status: LinkStatus;
}

export interface PeersState {
  enabled: boolean;
  hostEnabled: boolean;
  deviceId: string | null;
  deviceName: string;
  relayUrl: string | null;
  clients: ClientDevice[];
  hosts: HostDevice[];
}

export const shell = {
  engineStatus: () => call<EngineStatus>("engine_status", {}),
  peersState: () => call<PeersState>("peers_state", {}),
  setHostEnabled: (enabled: boolean) => call<void>("peers_set_host_enabled", { enabled }),
  setDeviceName: (name: string) => call<void>("peers_set_device_name", { name }),
  setRelay: (relayUrl: string | null) => call<void>("peers_set_relay", { relayUrl }),
  createPairingCode: (access: PeerAccess) => call<string>("peers_create_pairing_code", { access }),
  pairWith: (code: string) => call<HostDevice>("peers_pair_with", { code }),
  setAccess: (deviceId: string, access: PeerAccess) => call<void>("peers_set_access", { deviceId, access }),
  removeDevice: (deviceId: string) => call<void>("peers_remove", { deviceId }),
};

/** A peer stream may also carry `{ type: "resync" }` when events were dropped. */
export type DeviceEvent = { device: string; event: EngineEvent | { type: "resync" } };

export function onEngineEvent(handler: (payload: DeviceEvent) => void): Promise<UnlistenFn> {
  return listen<DeviceEvent>("engine://event", (message) => handler(message.payload));
}

export function onEngineStatus(handler: (status: EngineStatus) => void): Promise<UnlistenFn> {
  return listen<EngineStatus>("engine://status", (message) => handler(message.payload));
}

export function onPeersChanged(handler: (state: PeersState) => void): Promise<UnlistenFn> {
  return listen<PeersState>("peers://changed", (message) => handler(message.payload));
}
