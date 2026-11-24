//! Optional peer-to-peer control between Session Hub installs (iroh/QUIC, dialed by public key).
//!
//! * Host side: lets paired client devices call this engine, each with its own access level.
//! * Client side: keeps links to paired hosts, proxies RPCs and relays their (masked) events to the UI.
//!
//! Pairing is a one-time code; afterwards every connection is authenticated by the device key.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, RwLock};

use crate::engine::{EngineHandle, RpcError, UI_EVENT};

const RPC_ALPN: &[u8] = b"session-hub/rpc/1";
const PAIR_ALPN: &[u8] = b"session-hub/pair/1";
const CONFIG_FILE: &str = "peers.json";
const KEY_FILE: &str = "peer-identity.key";
const PAIRING_CODE_TTL: Duration = Duration::from_secs(10 * 60);
const PAIRING_TOKEN_BYTES: usize = 16;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const REMOTE_RPC_TIMEOUT: Duration = Duration::from_secs(130);
/** First contact may need a relay round trip plus hole punching. */
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/** How long to wait for the relay before handing out or redeeming a pairing code. */
const ONLINE_WAIT: Duration = Duration::from_secs(15);
const ONLINE_PROBE: Duration = Duration::from_millis(400);
const RECONNECT_BASE: Duration = Duration::from_secs(2);
const RECONNECT_MAX: Duration = Duration::from_secs(60);
pub const UI_PEERS: &str = "peers://changed";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    ReadOnly,
    Operator,
    Full,
}

/// A device allowed to control this one.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientDevice {
    pub id: String,
    pub name: String,
    pub access: Access,
    pub paired_at: u64,
}

/// A device this one controls.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDevice {
    pub id: String,
    pub name: String,
    pub access: Access,
    pub paired_at: u64,
    /// Last known address (direct IPs + relay); the id alone also works through discovery.
    pub addr: Option<EndpointAddr>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PeerConfig {
    pub host_enabled: bool,
    pub relay_url: Option<String>,
    pub device_name: String,
    pub clients: Vec<ClientDevice>,
    pub hosts: Vec<HostDevice>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LinkStatus {
    Connecting,
    Online,
    Offline,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeersState {
    pub enabled: bool,
    pub host_enabled: bool,
    pub device_id: Option<String>,
    pub device_name: String,
    pub relay_url: Option<String>,
    pub clients: Vec<ClientView>,
    pub hosts: Vec<HostView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    #[serde(flatten)]
    pub device: ClientDevice,
    pub connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub id: String,
    pub name: String,
    pub access: Access,
    pub paired_at: u64,
    pub status: LinkStatus,
}

#[derive(Debug, thiserror::Error)]
pub enum PeerError {
    #[error("remote control is off on this device; turn it on first")]
    HostDisabled,
    #[error("invalid pairing code")]
    BadCode,
    #[error("pairing failed: {0}")]
    Pairing(String),
    #[error("unknown device")]
    UnknownDevice,
    #[error("device is offline")]
    Offline,
    #[error("network error: {0}")]
    Network(String),
    #[error("storage error: {0}")]
    Storage(String),
}

impl From<PeerError> for RpcError {
    fn from(err: PeerError) -> Self {
        let code = match err {
            PeerError::Offline => "PEER_OFFLINE",
            PeerError::UnknownDevice => "NOT_FOUND",
            _ => "PEER_ERROR",
        };
        RpcError::Remote(code.to_owned(), err.to_string())
    }
}

/// A freshly created code. Without a relay address it only works from the same network.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub code: String,
    pub via_relay: bool,
}

/// What the UI shows under "Bağlantı tanılama".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerDiagnostics {
    pub active: bool,
    /// "connecting" right after start (the first relay handshake takes a few seconds), then "online"/"offline".
    pub relay_state: &'static str,
    pub online: bool,
    pub relay_urls: Vec<String>,
    pub direct_addresses: Vec<String>,
    pub custom_relay: bool,
}

#[derive(Serialize, Deserialize)]
struct PairingCodePayload {
    v: u8,
    addr: EndpointAddr,
    token: String,
    name: String,
}

#[derive(Serialize, Deserialize)]
struct PairRequest {
    token: String,
    name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    ok: bool,
    host_name: String,
    access: Option<Access>,
    error: Option<String>,
}

struct PendingPairing {
    access: Access,
    expires: Instant,
}

struct HostLink {
    status: LinkStatus,
    connection: Option<Connection>,
}

struct Inner {
    app: AppHandle,
    engine: EngineHandle,
    data_dir: PathBuf,
    config: RwLock<PeerConfig>,
    endpoint: RwLock<Option<Endpoint>>,
    pairing: Mutex<HashMap<String, PendingPairing>>,
    links: RwLock<HashMap<String, HostLink>>,
    client_connections: Mutex<HashMap<String, Vec<Connection>>>,
    bound_at: Mutex<Option<Instant>>,
}

/// Managed Tauri state for everything P2P.
#[derive(Clone)]
pub struct Peers {
    inner: Arc<Inner>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn device_hostname() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

fn storage(err: impl std::fmt::Display) -> PeerError {
    PeerError::Storage(err.to_string())
}

fn network(err: impl std::fmt::Display) -> PeerError {
    PeerError::Network(err.to_string())
}

impl Peers {
    pub fn new(app: AppHandle, engine: EngineHandle, data_dir: PathBuf) -> Self {
        let mut config = load_config(&data_dir).unwrap_or_default();
        if config.device_name.trim().is_empty() {
            config.device_name = device_hostname();
        }
        Self {
            inner: Arc::new(Inner {
                app,
                engine,
                data_dir,
                config: RwLock::new(config),
                endpoint: RwLock::new(None),
                pairing: Mutex::new(HashMap::new()),
                links: RwLock::new(HashMap::new()),
                client_connections: Mutex::new(HashMap::new()),
                bound_at: Mutex::new(None),
            }),
        }
    }

    /// Binds the endpoint only when P2P is in use (host on, or at least one paired host).
    pub async fn start(&self) -> Result<(), PeerError> {
        let needed = {
            let config = self.inner.config.read().await;
            config.host_enabled || !config.hosts.is_empty()
        };
        if needed {
            self.ensure_endpoint().await?;
        }
        Ok(())
    }

    async fn ensure_endpoint(&self) -> Result<Endpoint, PeerError> {
        if let Some(endpoint) = self.inner.endpoint.read().await.clone() {
            return Ok(endpoint);
        }
        let mut slot = self.inner.endpoint.write().await;
        if let Some(endpoint) = slot.clone() {
            return Ok(endpoint);
        }
        let key = load_or_create_key(&self.inner.data_dir)?;
        let relay_mode = match self.inner.config.read().await.relay_url.as_deref() {
            Some(url) => RelayMode::Custom(RelayMap::from(url.parse::<RelayUrl>().map_err(network)?)),
            None => RelayMode::Default,
        };
        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(key)
            // Trust the OS certificate store (like browsers) for relay/pkarr/DoH TLS. Corporate networks that
            // inspect HTTPS re-sign with an IT-installed root that iroh's embedded Mozilla roots reject
            // ("invalid peer certificate: UnknownIssuer"). Peer traffic stays end-to-end authenticated by iroh.
            .ca_tls_config(iroh::tls::CaTlsConfig::system())
            .relay_mode(relay_mode)
            .alpns(vec![RPC_ALPN.to_vec(), PAIR_ALPN.to_vec()])
            .bind()
            .await
            .map_err(network)?;
        *slot = Some(endpoint.clone());
        drop(slot);
        *self.inner.bound_at.lock().await = Some(Instant::now());
        tokio::spawn(self.clone().accept_loop(endpoint.clone()));
        let hosts = self.inner.config.read().await.hosts.clone();
        for host in hosts {
            tokio::spawn(self.clone().maintain_link(host.id));
        }
        log::info!("p2p endpoint bound as {}", endpoint.id());
        Ok(endpoint)
    }

    /// Rebinds after relay changes; links reconnect on their own.
    async fn restart_endpoint(&self) -> Result<(), PeerError> {
        if let Some(endpoint) = self.inner.endpoint.write().await.take() {
            endpoint.close().await;
        }
        self.start().await
    }

    pub async fn state(&self) -> PeersState {
        let config = self.inner.config.read().await.clone();
        let device_id = self.inner.endpoint.read().await.as_ref().map(|endpoint| endpoint.id().to_string());
        let device_id = match device_id {
            Some(id) => Some(id),
            None => load_existing_key(&self.inner.data_dir).map(|key| key.public().to_string()),
        };
        let connections = self.inner.client_connections.lock().await;
        let links = self.inner.links.read().await;
        PeersState {
            enabled: config.host_enabled || !config.hosts.is_empty(),
            host_enabled: config.host_enabled,
            device_id,
            device_name: config.device_name.clone(),
            relay_url: config.relay_url.clone(),
            clients: config
                .clients
                .iter()
                .map(|client| ClientView {
                    device: client.clone(),
                    connected: connections.get(&client.id).is_some_and(|list| list.iter().any(|conn| conn.close_reason().is_none())),
                })
                .collect(),
            hosts: config
                .hosts
                .iter()
                .map(|host| HostView {
                    id: host.id.clone(),
                    name: host.name.clone(),
                    access: host.access,
                    paired_at: host.paired_at,
                    status: links.get(&host.id).map(|link| link.status).unwrap_or(LinkStatus::Offline),
                })
                .collect(),
        }
    }

    async fn notify_changed(&self) {
        let state = self.state().await;
        if let Err(err) = self.inner.app.emit(UI_PEERS, &state) {
            log::warn!("emit peers state failed: {err}");
        }
    }

    async fn update_config(&self, change: impl FnOnce(&mut PeerConfig)) -> Result<(), PeerError> {
        let snapshot = {
            let mut config = self.inner.config.write().await;
            change(&mut config);
            config.clone()
        };
        save_config(&self.inner.data_dir, &snapshot)?;
        self.notify_changed().await;
        Ok(())
    }

    // ── settings (local UI only) ─────────────────────────────────────────────

    pub async fn set_host_enabled(&self, enabled: bool) -> Result<(), PeerError> {
        self.update_config(|config| config.host_enabled = enabled).await?;
        if enabled {
            self.ensure_endpoint().await?;
        } else {
            self.inner.pairing.lock().await.clear();
            for (_, connections) in self.inner.client_connections.lock().await.drain() {
                for connection in connections {
                    connection.close(0u32.into(), b"remote control disabled");
                }
            }
        }
        self.notify_changed().await;
        Ok(())
    }

    pub async fn set_device_name(&self, name: String) -> Result<(), PeerError> {
        let trimmed = name.trim().chars().take(60).collect::<String>();
        if trimmed.is_empty() {
            return Err(PeerError::Storage("device name cannot be empty".into()));
        }
        self.update_config(|config| config.device_name = trimmed).await
    }

    pub async fn set_relay(&self, relay_url: Option<String>) -> Result<(), PeerError> {
        if let Some(url) = relay_url.as_deref() {
            url.parse::<RelayUrl>().map_err(network)?;
        }
        self.update_config(|config| config.relay_url = relay_url).await?;
        self.restart_endpoint().await
    }

    pub async fn set_client_access(&self, device_id: String, access: Access) -> Result<(), PeerError> {
        let mut found = false;
        self.update_config(|config| {
            for client in config.clients.iter_mut().filter(|client| client.id == device_id) {
                client.access = access;
                found = true;
            }
        })
        .await?;
        if found { Ok(()) } else { Err(PeerError::UnknownDevice) }
    }

    /// Unpairs in either direction and drops any live connection with that device.
    pub async fn remove(&self, device_id: String) -> Result<(), PeerError> {
        self.update_config(|config| {
            config.clients.retain(|client| client.id != device_id);
            config.hosts.retain(|host| host.id != device_id);
        })
        .await?;
        if let Some(connections) = self.inner.client_connections.lock().await.remove(&device_id) {
            for connection in connections {
                connection.close(0u32.into(), b"unpaired");
            }
        }
        let link = self.inner.links.write().await.remove(&device_id);
        if let Some(connection) = link.and_then(|link| link.connection) {
            connection.close(0u32.into(), b"unpaired");
        }
        self.notify_changed().await;
        Ok(())
    }

    // ── pairing ──────────────────────────────────────────────────────────────

    /// Host side: a one-time code (valid 10 minutes) that grants `access` to whoever redeems it.
    pub async fn create_pairing_code(&self, access: Access) -> Result<PairingCode, PeerError> {
        let (enabled, name) = {
            let config = self.inner.config.read().await;
            (config.host_enabled, config.device_name.clone())
        };
        if !enabled {
            return Err(PeerError::HostDisabled);
        }
        let endpoint = self.ensure_endpoint().await?;
        // The code must carry the relay address to work from another network; give the relay time to answer.
        let online = tokio::time::timeout(ONLINE_WAIT, endpoint.online()).await.is_ok();
        if !online {
            log::warn!("pairing code created without a relay connection; it will only work on the same network");
        }
        let mut bytes = [0u8; PAIRING_TOKEN_BYTES];
        rand::rng().fill_bytes(&mut bytes);
        let token = URL_SAFE_NO_PAD.encode(bytes);
        let mut pairing = self.inner.pairing.lock().await;
        pairing.retain(|_, pending| pending.expires > Instant::now());
        pairing.insert(token.clone(), PendingPairing { access, expires: Instant::now() + PAIRING_CODE_TTL });
        let addr = endpoint.addr();
        // The address can name a relay that was chosen but never connected; only a live relay link counts.
        let via_relay = online && addr.relay_urls().next().is_some();
        log::info!("pairing code created (relay: {via_relay}, direct addresses: {})", addr.ip_addrs().count());
        let payload = PairingCodePayload { v: 1, addr, token, name };
        let json = serde_json::to_vec(&payload).map_err(storage)?;
        Ok(PairingCode { code: format!("SHUB1.{}", URL_SAFE_NO_PAD.encode(json)), via_relay })
    }

    /// Client side: redeem a host's pairing code.
    pub async fn pair_with(&self, code: String) -> Result<HostView, PeerError> {
        let payload = code.trim().strip_prefix("SHUB1.").ok_or(PeerError::BadCode)?;
        let decoded = URL_SAFE_NO_PAD.decode(payload).map_err(|_| PeerError::BadCode)?;
        let code: PairingCodePayload = serde_json::from_slice(&decoded).map_err(|_| PeerError::BadCode)?;
        let endpoint = self.ensure_endpoint().await?;
        // Our own relay link speeds up reaching a host on another network; do not wait forever for it.
        let online = tokio::time::timeout(ONLINE_WAIT, endpoint.online()).await.is_ok();
        log::info!(
            "pairing: this device online={online}; host advertises relay={} direct={}",
            code.addr.relay_urls().next().is_some(),
            code.addr.ip_addrs().count()
        );
        if code.addr.id == endpoint.id() {
            return Err(PeerError::Pairing("this code belongs to this device".into()));
        }
        let name = self.inner.config.read().await.device_name.clone();
        let host_has_relay = code.addr.relay_urls().next().is_some();
        let connection = match tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(code.addr.clone(), PAIR_ALPN)).await {
            Ok(Ok(connection)) => connection,
            Ok(Err(err)) => {
                log::warn!("pairing connect failed: {err}");
                return Err(network(err));
            }
            Err(_) => {
                log::warn!("pairing connect timed out (this device online={online}, host relay={host_has_relay})");
                return Err(PeerError::Network(unreachable_hint(online, host_has_relay)));
            }
        };
        let request = serde_json::to_vec(&PairRequest { token: code.token, name }).map_err(storage)?;
        let response = request_response(&connection, &request).await?;
        connection.close(0u32.into(), b"paired");
        let response: PairResponse = serde_json::from_slice(&response).map_err(|_| PeerError::Pairing("bad response".into()))?;
        let access = match (response.ok, response.access) {
            (true, Some(access)) => access,
            _ => return Err(PeerError::Pairing(response.error.unwrap_or_else(|| "rejected".into()))),
        };
        let host = HostDevice { id: code.addr.id.to_string(), name: response.host_name, access, paired_at: now_secs(), addr: Some(code.addr) };
        let view = HostView { id: host.id.clone(), name: host.name.clone(), access, paired_at: host.paired_at, status: LinkStatus::Connecting };
        let host_id = host.id.clone();
        self.update_config(|config| {
            config.hosts.retain(|existing| existing.id != host.id);
            config.hosts.push(host);
        })
        .await?;
        tokio::spawn(self.clone().maintain_link(host_id));
        Ok(view)
    }

    /// Live view of this device's P2P reachability for the diagnostics card.
    pub async fn diagnostics(&self) -> PeerDiagnostics {
        let custom_relay = self.inner.config.read().await.relay_url.is_some();
        let Some(endpoint) = self.inner.endpoint.read().await.clone() else {
            return PeerDiagnostics { active: false, relay_state: "offline", online: false, relay_urls: vec![], direct_addresses: vec![], custom_relay };
        };
        let online = tokio::time::timeout(ONLINE_PROBE, endpoint.online()).await.is_ok();
        let starting = self.inner.bound_at.lock().await.is_some_and(|at| at.elapsed() < ONLINE_WAIT);
        let relay_state = if online { "online" } else if starting { "connecting" } else { "offline" };
        let addr = endpoint.addr();
        PeerDiagnostics {
            active: true,
            relay_state,
            online,
            relay_urls: addr.relay_urls().map(|url| url.to_string()).collect(),
            direct_addresses: addr.ip_addrs().map(|ip| ip.to_string()).collect(),
            custom_relay,
        }
    }

    // ── host side ────────────────────────────────────────────────────────────

    async fn accept_loop(self, endpoint: Endpoint) {
        while let Some(incoming) = endpoint.accept().await {
            let peers = self.clone();
            tokio::spawn(async move {
                let connection = match incoming.await {
                    Ok(connection) => connection,
                    Err(err) => {
                        log::debug!("incoming connection failed: {err}");
                        return;
                    }
                };
                let alpn = connection.alpn().to_vec();
                let remote = connection.remote_id();
                log::info!("incoming connection from {} ({})", remote.fmt_short(), String::from_utf8_lossy(&alpn));
                if !peers.inner.config.read().await.host_enabled {
                    log::warn!("rejected {}: remote control is off", remote.fmt_short());
                    connection.close(1u32.into(), b"remote control disabled");
                    return;
                }
                if alpn == PAIR_ALPN {
                    peers.serve_pairing(connection).await;
                } else if alpn == RPC_ALPN {
                    peers.serve_client(connection).await;
                }
            });
        }
    }

    async fn serve_pairing(&self, connection: Connection) {
        let Ok((mut send, mut recv)) = connection.accept_bi().await else { return };
        let Ok(raw) = recv.read_to_end(MAX_REQUEST_BYTES).await else { return };
        let host_name = self.inner.config.read().await.device_name.clone();
        let response = match serde_json::from_slice::<PairRequest>(&raw) {
            Ok(request) => self.redeem(&request, connection.remote_id()).await,
            Err(_) => Err("malformed request".to_owned()),
        };
        match &response {
            Ok(access) => log::info!("paired with {} as {access:?}", connection.remote_id().fmt_short()),
            Err(error) => log::warn!("pairing from {} refused: {error}", connection.remote_id().fmt_short()),
        }
        let body = match response {
            Ok(access) => PairResponse { ok: true, host_name, access: Some(access), error: None },
            Err(error) => PairResponse { ok: false, host_name, access: None, error: Some(error) },
        };
        if let Ok(bytes) = serde_json::to_vec(&body) {
            let _ = send.write_all(&bytes).await;
            let _ = send.finish();
        }
        connection.closed().await;
    }

    async fn redeem(&self, request: &PairRequest, remote: EndpointId) -> Result<Access, String> {
        let pending = {
            let mut pairing = self.inner.pairing.lock().await;
            pairing.remove(&request.token)
        };
        let Some(pending) = pending.filter(|pending| pending.expires > Instant::now()) else {
            return Err("code is invalid or expired".into());
        };
        let name = request.name.trim().chars().take(60).collect::<String>();
        let client = ClientDevice { id: remote.to_string(), name: if name.is_empty() { "device".into() } else { name }, access: pending.access, paired_at: now_secs() };
        self.update_config(|config| {
            config.clients.retain(|existing| existing.id != client.id);
            config.clients.push(client);
        })
        .await
        .map_err(|err| err.to_string())?;
        Ok(pending.access)
    }

    fn client_for<'a>(config: &'a PeerConfig, id: &str) -> Option<&'a ClientDevice> {
        config.clients.iter().find(|client| client.id == id)
    }

    async fn serve_client(&self, connection: Connection) {
        let remote = connection.remote_id().to_string();
        if Self::client_for(&*self.inner.config.read().await, &remote).is_none() {
            log::warn!("rejected unpaired device {}", connection.remote_id().fmt_short());
            connection.close(2u32.into(), b"not paired");
            return;
        }
        self.inner.client_connections.lock().await.entry(remote.clone()).or_default().push(connection.clone());
        self.notify_changed().await;
        while let Ok((send, recv)) = connection.accept_bi().await {
            let peers = self.clone();
            let remote = remote.clone();
            tokio::spawn(async move { peers.serve_stream(&remote, send, recv).await });
        }
        if let Some(list) = self.inner.client_connections.lock().await.get_mut(&remote) {
            list.retain(|conn| conn.close_reason().is_none());
        }
        self.notify_changed().await;
    }

    async fn serve_stream(&self, remote: &str, mut send: iroh::endpoint::SendStream, mut recv: iroh::endpoint::RecvStream) {
        let Ok(raw) = recv.read_to_end(MAX_REQUEST_BYTES).await else { return };
        let Ok(request) = serde_json::from_slice::<Value>(&raw) else { return };
        // Access is re-read on every request so unpairing or downgrading takes effect immediately.
        let client = Self::client_for(&*self.inner.config.read().await, remote).cloned();
        let Some(client) = client else {
            let _ = send.write_all(br#"{"ok":false,"error":{"code":"FORBIDDEN","message":"device is no longer paired"}}"#).await;
            let _ = send.finish();
            return;
        };
        match request.get("op").and_then(Value::as_str) {
            Some("rpc") => {
                let method = request.get("method").and_then(Value::as_str).unwrap_or_default();
                let params = request.get("params").cloned().unwrap_or(Value::Null);
                let caller = json!({ "kind": "peer", "deviceId": client.id, "deviceName": client.name, "access": client.access });
                let response = match self.inner.engine.rpc(method, params, caller).await {
                    Ok(result) => json!({ "ok": true, "result": result }),
                    Err(err) => json!({ "ok": false, "error": { "code": err.code(), "message": err.to_string() } }),
                };
                let _ = send.write_all(response.to_string().as_bytes()).await;
                let _ = send.finish();
            }
            Some("subscribe") => {
                let mut events = self.inner.engine.subscribe_peer_events();
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            let line = format!("{event}\n");
                            if send.write_all(line.as_bytes()).await.is_err() {
                                break;
                            }
                        }
                        // A slow client missed events; it refetches on the resync marker.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            if send.write_all(b"{\"type\":\"resync\"}\n").await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
            _ => {}
        }
    }

    // ── client side ──────────────────────────────────────────────────────────

    async fn set_link(&self, host_id: &str, status: LinkStatus, connection: Option<Connection>) {
        self.inner.links.write().await.insert(host_id.to_owned(), HostLink { status, connection });
        self.notify_changed().await;
    }

    async fn host(&self, host_id: &str) -> Option<HostDevice> {
        self.inner.config.read().await.hosts.iter().find(|host| host.id == host_id).cloned()
    }

    /// Keeps one connection to a paired host alive, with jittered backoff, until the host is unpaired.
    async fn maintain_link(self, host_id: String) {
        let mut failures: u32 = 0;
        loop {
            let Some(host) = self.host(&host_id).await else { return };
            let Some(endpoint) = self.inner.endpoint.read().await.clone() else { return };
            self.set_link(&host_id, LinkStatus::Connecting, None).await;
            let target: EndpointAddr = match (&host.addr, host.id.parse::<EndpointId>()) {
                (Some(addr), _) => addr.clone(),
                (None, Ok(id)) => id.into(),
                (None, Err(_)) => return,
            };
            match tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(target, RPC_ALPN)).await {
                Ok(Ok(connection)) => {
                    failures = 0;
                    self.set_link(&host_id, LinkStatus::Online, Some(connection.clone())).await;
                    self.forward_events(&host_id, &connection).await;
                    connection.closed().await;
                }
                Ok(Err(err)) => log::warn!("link to {host_id} failed: {err}"),
                Err(_) => log::warn!("link to {host_id} timed out"),
            }
            if self.host(&host_id).await.is_none() {
                return;
            }
            self.set_link(&host_id, LinkStatus::Offline, None).await;
            failures = failures.saturating_add(1);
            let exponent = failures.saturating_sub(1).min(5);
            let base = RECONNECT_BASE.saturating_mul(1 << exponent).min(RECONNECT_MAX);
            let jitter = Duration::from_millis(rand::random::<u64>() % (base.as_millis() as u64 / 4 + 1));
            tokio::time::sleep(base + jitter).await;
        }
    }

    /// Subscribes to the host's event stream and re-emits each event to the UI tagged with the host id.
    async fn forward_events(&self, host_id: &str, connection: &Connection) {
        let Ok((mut send, recv)) = connection.open_bi().await else { return };
        if send.write_all(br#"{"op":"subscribe"}"#).await.is_err() || send.finish().is_err() {
            return;
        }
        let app = self.inner.app.clone();
        let device = host_id.to_owned();
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(recv).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
                crate::notify::maybe_notify(&app, &event);
                if let Err(err) = app.emit(UI_EVENT, json!({ "device": device, "event": event })) {
                    log::warn!("emit peer event failed: {err}");
                }
            }
        });
    }

    /// Proxies one RPC to a paired host. The host decides what this device may do.
    pub async fn remote_rpc(&self, device: &str, method: &str, params: Value) -> Result<Value, RpcError> {
        let connection = {
            let links = self.inner.links.read().await;
            let link = links.get(device).ok_or(PeerError::UnknownDevice)?;
            link.connection.clone().ok_or(PeerError::Offline)?
        };
        let request = json!({ "op": "rpc", "method": method, "params": params }).to_string();
        let raw = tokio::time::timeout(REMOTE_RPC_TIMEOUT, request_response(&connection, request.as_bytes()))
            .await
            .map_err(|_| RpcError::Timeout)??;
        let response: Value = serde_json::from_slice(&raw).map_err(|_| PeerError::Network("bad response".into()))?;
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
        let error = response.get("error").cloned().unwrap_or(Value::Null);
        Err(RpcError::Remote(
            error.get("code").and_then(Value::as_str).unwrap_or("REMOTE").to_owned(),
            error.get("message").and_then(Value::as_str).unwrap_or("remote error").to_owned(),
        ))
    }
}

/// Turns a pairing timeout into something the owner can act on.
fn unreachable_hint(this_online: bool, host_has_relay: bool) -> String {
    if !host_has_relay {
        "Host cevap vermedi. Kod relay adresi içermiyor: kodu oluşturan cihaz relay'e bağlanamamış, bu kod sadece aynı ağdan çalışır. O cihazda Ayarlar → Cihazlar → Bağlantı tanılama'ya bak.".into()
    } else if !this_online {
        "Host cevap vermedi. Bu cihaz relay sunucusuna bağlanamıyor; ağ (güvenlik duvarı/proxy) engelliyor olabilir. Ayarlar → Cihazlar → Bağlantı tanılama'ya bak.".into()
    } else {
        "Host cevap vermedi. Kodu oluşturan cihazda uzaktan kontrol açık ve uygulama çalışıyor olmalı; Windows'ta güvenlik duvarı izni gerekebilir.".into()
    }
}

async fn request_response(connection: &Connection, request: &[u8]) -> Result<Vec<u8>, PeerError> {
    let (mut send, mut recv) = connection.open_bi().await.map_err(network)?;
    send.write_all(request).await.map_err(network)?;
    send.finish().map_err(network)?;
    recv.read_to_end(MAX_RESPONSE_BYTES).await.map_err(network)
}

fn load_config(dir: &Path) -> Option<PeerConfig> {
    let raw = std::fs::read(dir.join(CONFIG_FILE)).ok()?;
    serde_json::from_slice(&raw).map_err(|err| log::error!("peers.json is unreadable: {err}")).ok()
}

fn save_config(dir: &Path, config: &PeerConfig) -> Result<(), PeerError> {
    let path = dir.join(CONFIG_FILE);
    let temp = dir.join(format!("{CONFIG_FILE}.tmp"));
    std::fs::write(&temp, serde_json::to_vec_pretty(config).map_err(storage)?).map_err(storage)?;
    std::fs::rename(&temp, &path).map_err(storage)
}

fn load_existing_key(dir: &Path) -> Option<SecretKey> {
    let bytes = std::fs::read(dir.join(KEY_FILE)).ok()?;
    let array: [u8; 32] = bytes.try_into().ok()?;
    Some(SecretKey::from_bytes(&array))
}

/// The device identity. Owner-only file; losing it means re-pairing.
fn load_or_create_key(dir: &Path) -> Result<SecretKey, PeerError> {
    if let Some(key) = load_existing_key(dir) {
        return Ok(key);
    }
    let key = SecretKey::generate();
    let path = dir.join(KEY_FILE);
    std::fs::write(&path, key.to_bytes()).map_err(storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(storage)?;
    }
    Ok(key)
}
