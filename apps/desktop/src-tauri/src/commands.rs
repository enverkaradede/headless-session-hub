//! Tauri commands exposed to the React UI.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::engine::{EngineHandle, EngineStatus, RpcError};

pub const LOCAL_DEVICE: &str = "local";

/// Error shape the UI receives from every command.
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl From<RpcError> for CommandError {
    fn from(err: RpcError) -> Self {
        Self { code: err.code().to_owned(), message: err.to_string() }
    }
}

/// Calls the engine of `device` ("local" or a paired peer's id).
#[tauri::command]
pub async fn engine_rpc(
    engine: State<'_, EngineHandle>,
    peers: State<'_, crate::peers::Peers>,
    device: String,
    method: String,
    params: Value,
) -> Result<Value, CommandError> {
    if device == LOCAL_DEVICE {
        return Ok(engine.rpc(&method, params, json!({ "kind": "local" })).await?);
    }
    Ok(peers.remote_rpc(&device, &method, params).await?)
}

#[tauri::command]
pub async fn engine_status(engine: State<'_, EngineHandle>) -> Result<EngineStatus, CommandError> {
    Ok(engine.status().await)
}

// ── P2P (local UI only: pairing and access levels are never changed remotely) ──

use crate::peers::{Access, HostView, PairingCode, PeerDiagnostics, PeerError, Peers, PeersState};

impl From<PeerError> for CommandError {
    fn from(err: PeerError) -> Self {
        Self { code: "PEER_ERROR".into(), message: err.to_string() }
    }
}

#[tauri::command]
pub async fn peers_state(peers: State<'_, Peers>) -> Result<PeersState, CommandError> {
    Ok(peers.state().await)
}

#[tauri::command]
pub async fn peers_set_host_enabled(peers: State<'_, Peers>, enabled: bool) -> Result<(), CommandError> {
    Ok(peers.set_host_enabled(enabled).await?)
}

#[tauri::command]
pub async fn peers_set_device_name(peers: State<'_, Peers>, name: String) -> Result<(), CommandError> {
    Ok(peers.set_device_name(name).await?)
}

#[tauri::command]
pub async fn peers_set_relay(peers: State<'_, Peers>, relay_url: Option<String>) -> Result<(), CommandError> {
    Ok(peers.set_relay(relay_url.filter(|url| !url.trim().is_empty())).await?)
}

#[tauri::command]
pub async fn peers_create_pairing_code(peers: State<'_, Peers>, access: Access) -> Result<PairingCode, CommandError> {
    Ok(peers.create_pairing_code(access).await?)
}

#[tauri::command]
pub async fn peers_pair_with(peers: State<'_, Peers>, code: String) -> Result<HostView, CommandError> {
    Ok(peers.pair_with(code).await?)
}

#[tauri::command]
pub async fn peers_set_access(peers: State<'_, Peers>, device_id: String, access: Access) -> Result<(), CommandError> {
    Ok(peers.set_client_access(device_id, access).await?)
}

#[tauri::command]
pub async fn peers_diagnostics(peers: State<'_, Peers>) -> Result<PeerDiagnostics, CommandError> {
    Ok(peers.diagnostics().await)
}

#[tauri::command]
pub async fn peers_remove(peers: State<'_, Peers>, device_id: String) -> Result<(), CommandError> {
    Ok(peers.remove(device_id).await?)
}
