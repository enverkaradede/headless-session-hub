//! Supervises the Node engine sidecar and bridges JSON-lines RPC between it, the UI and peers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, RwLock};

/// Engine RPCs normally answer in milliseconds; session start runs `claude auth status` first.
const RPC_TIMEOUT: Duration = Duration::from_secs(120);
const RESTART_BASE_DELAY: Duration = Duration::from_secs(1);
const RESTART_MAX_DELAY: Duration = Duration::from_secs(60);
/// An engine that stayed up this long is considered healthy; the backoff resets.
const HEALTHY_UPTIME: Duration = Duration::from_secs(300);
const STDIN_QUEUE: usize = 256;
const PEER_EVENT_QUEUE: usize = 1024;
pub const UI_EVENT: &str = "engine://event";
pub const UI_STATUS: &str = "engine://status";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where the sidecar comes from (dev: system node + workspace bundle; release: bundled resources).
#[derive(Clone, Debug)]
pub struct EngineLaunch {
    pub node: PathBuf,
    pub script: PathBuf,
    pub data_dir: PathBuf,
    pub hubctl: Option<PathBuf>,
    pub log_file: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EngineStatus {
    Starting,
    Ready { info: Value },
    Restarting { attempt: u32, delay_ms: u64, reason: String },
}

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("engine is not running")]
    Unavailable,
    #[error("engine did not answer in time")]
    Timeout,
    /// An error the engine (or a peer) returned: (code, message).
    #[error("{1}")]
    Remote(String, String),
}

impl RpcError {
    pub fn code(&self) -> &str {
        match self {
            RpcError::Unavailable => "ENGINE_UNAVAILABLE",
            RpcError::Timeout => "TIMEOUT",
            RpcError::Remote(code, _) => code,
        }
    }
}

/// Callback for every engine event (used for native notifications).
pub type EventHook = Arc<dyn Fn(&AppHandle, &Value) + Send + Sync>;

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, RpcError>>>>>;

/// Cheap-to-clone handle used by commands and the P2P layer.
#[derive(Clone)]
pub struct EngineHandle {
    stdin: Arc<RwLock<Option<mpsc::Sender<String>>>>,
    pending: Pending,
    status: Arc<RwLock<EngineStatus>>,
    next_id: Arc<AtomicU64>,
    peer_events: broadcast::Sender<Value>,
}

impl EngineHandle {
    pub fn new() -> Self {
        let (peer_events, _) = broadcast::channel(PEER_EVENT_QUEUE);
        Self {
            stdin: Arc::new(RwLock::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            status: Arc::new(RwLock::new(EngineStatus::Starting)),
            next_id: Arc::new(AtomicU64::new(1)),
            peer_events,
        }
    }

    pub async fn status(&self) -> EngineStatus {
        self.status.read().await.clone()
    }

    /// Masked, peer-safe engine events for the P2P host side.
    pub fn subscribe_peer_events(&self) -> broadcast::Receiver<Value> {
        self.peer_events.subscribe()
    }

    /// Sends one RPC. `caller` is stamped by the shell (local UI, or a peer with its stored access level).
    pub async fn rpc(&self, method: &str, params: Value, caller: Value) -> Result<Value, RpcError> {
        let sender = self.stdin.read().await.clone().ok_or(RpcError::Unavailable)?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        let line = json!({ "t": "req", "id": id, "method": method, "params": params, "caller": caller }).to_string();
        if sender.send(line).await.is_err() {
            self.pending.lock().await.remove(&id);
            return Err(RpcError::Unavailable);
        }
        match tokio::time::timeout(RPC_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::Unavailable),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(RpcError::Timeout)
            }
        }
    }

    async fn set_status(&self, app: &AppHandle, status: EngineStatus) {
        *self.status.write().await = status.clone();
        if let Err(err) = app.emit(UI_STATUS, &status) {
            log::warn!("emit engine status failed: {err}");
        }
    }

    async fn fail_pending(&self) {
        let mut pending = self.pending.lock().await;
        for (_, waiter) in pending.drain() {
            let _ = waiter.send(Err(RpcError::Unavailable));
        }
    }

    /// Runs forever: start the engine, pump its output, restart it with jittered backoff when it dies.
    pub async fn supervise(self, app: AppHandle, launch: EngineLaunch, on_event: EventHook) {
        let mut attempt: u32 = 0;
        loop {
            self.set_status(&app, EngineStatus::Starting).await;
            let started = Instant::now();
            let reason = match self.run_once(&app, &launch, on_event.clone()).await {
                Ok(code) => format!("engine exited ({code})"),
                Err(err) => format!("engine failed to start: {err}"),
            };
            log::warn!("{reason}");
            *self.stdin.write().await = None;
            self.fail_pending().await;
            if started.elapsed() >= HEALTHY_UPTIME {
                attempt = 0;
            }
            attempt = attempt.saturating_add(1);
            let delay = backoff(attempt);
            self.set_status(&app, EngineStatus::Restarting { attempt, delay_ms: delay.as_millis() as u64, reason }).await;
            tokio::time::sleep(delay).await;
        }
    }

    async fn run_once(&self, app: &AppHandle, launch: &EngineLaunch, on_event: EventHook) -> std::io::Result<String> {
        let mut child = spawn_engine(launch)?;
        let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| std::io::Error::other("no stderr"))?;
        let mut stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("no stdin"))?;

        let (tx, mut rx) = mpsc::channel::<String>(STDIN_QUEUE);
        *self.stdin.write().await = Some(tx);
        let writer = tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });
        let log_task = tokio::spawn(pump_stderr(stderr, launch.log_file.clone()));

        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await? {
            self.handle_line(app, &line, &on_event).await;
        }
        writer.abort();
        log_task.abort();
        let status = child.wait().await?;
        Ok(status.to_string())
    }

    async fn handle_line(&self, app: &AppHandle, line: &str, on_event: &EventHook) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            log::warn!("engine wrote a non-JSON line ({} bytes)", line.len());
            return;
        };
        match message.get("t").and_then(Value::as_str) {
            Some("res") => {
                let id = message.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                let Some(waiter) = self.pending.lock().await.remove(&id) else { return };
                let result = if message.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    let error = message.get("error").cloned().unwrap_or(Value::Null);
                    let code = error.get("code").and_then(Value::as_str).unwrap_or("INTERNAL").to_owned();
                    let text = error.get("message").and_then(Value::as_str).unwrap_or("engine error").to_owned();
                    Err(RpcError::Remote(code, text))
                };
                let _ = waiter.send(result);
            }
            Some("evt") => {
                let event = message.get("event").cloned().unwrap_or(Value::Null);
                on_event(app, &event);
                if let Err(err) = app.emit(UI_EVENT, json!({ "device": "local", "event": event })) {
                    log::warn!("emit engine event failed: {err}");
                }
            }
            Some("pevt") => {
                // No subscribers simply means no peers are connected.
                let _ = self.peer_events.send(message.get("event").cloned().unwrap_or(Value::Null));
            }
            Some("ready") => {
                let info = message.get("info").cloned().unwrap_or(Value::Null);
                self.set_status(app, EngineStatus::Ready { info }).await;
            }
            _ => log::warn!("engine wrote an unknown message type"),
        }
    }
}

fn backoff(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(6);
    let base = RESTART_BASE_DELAY.saturating_mul(1 << exponent).min(RESTART_MAX_DELAY);
    let jitter_ms = rand::rng().random_range(0..=base.as_millis() as u64 / 4);
    base + Duration::from_millis(jitter_ms)
}

fn spawn_engine(launch: &EngineLaunch) -> std::io::Result<Child> {
    let mut command = Command::new(&launch.node);
    command
        .arg("--no-warnings=ExperimentalWarning")
        .arg(&launch.script)
        .arg("--data-dir")
        .arg(&launch.data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(hubctl) = &launch.hubctl {
        command.arg("--hubctl").arg(hubctl);
    }
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

/// Appends engine stderr (structured JSON logs) to a size-capped log file.
async fn pump_stderr(stderr: tokio::process::ChildStderr, log_file: PathBuf) {
    const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
    if let Ok(meta) = tokio::fs::metadata(&log_file).await
        && meta.len() > MAX_LOG_BYTES
    {
        let _ = tokio::fs::rename(&log_file, log_file.with_extension("log.1")).await;
    }
    let Ok(mut file) = tokio::fs::OpenOptions::new().create(true).append(true).open(&log_file).await else {
        log::warn!("cannot open engine log file");
        return;
    };
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let _ = file.write_all(line.as_bytes()).await;
        let _ = file.write_all(b"\n").await;
    }
}
