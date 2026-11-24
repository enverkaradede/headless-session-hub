//! Session Hub desktop shell: window, tray, engine sidecar supervision and the optional P2P layer.

mod commands;
mod engine;
mod notify;
mod peers;
mod tray;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::engine::{EngineHandle, EngineLaunch, EventHook};
use crate::peers::Peers;

/// Passed by the autostart entry so a login launch stays in the tray.
const HIDDEN_FLAG: &str = "--hidden";

fn exe_name(base: &str) -> String {
    if cfg!(windows) { format!("{base}.exe") } else { base.to_owned() }
}

/// Dev builds use the system `node` and the workspace bundle; release builds use bundled resources.
fn engine_launch(app: &AppHandle) -> Result<EngineLaunch, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    let log_dir = app.path().app_log_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    std::fs::create_dir_all(&log_dir)?;
    let log_file = log_dir.join("engine.log");
    if cfg!(debug_assertions) {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let node = std::env::var_os("HUB_NODE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("node"));
        let script = std::env::var_os("HUB_ENGINE_SCRIPT")
            .map(PathBuf::from)
            .unwrap_or_else(|| workspace.join("packages/engine/dist/engine.mjs"));
        let hubctl = workspace.join("target/debug").join(exe_name("hubctl"));
        return Ok(EngineLaunch { node, script, data_dir, hubctl: hubctl.exists().then_some(hubctl), log_file });
    }
    let resources = app.path().resource_dir()?;
    let exe_dir = std::env::current_exe()?.parent().map(PathBuf::from).ok_or("no exe dir")?;
    let hubctl = exe_dir.join(exe_name("hubctl"));
    Ok(EngineLaunch {
        node: resources.join("resources/node").join(exe_name("node")),
        script: resources.join("resources/engine/engine.mjs"),
        data_dir,
        hubctl: hubctl.exists().then_some(hubctl),
        log_file,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_FLAG])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let engine = EngineHandle::new();
            app.manage(engine.clone());
            let launch = engine_launch(&handle)?;
            let peers = Peers::new(handle.clone(), engine.clone(), launch.data_dir.clone());
            app.manage(peers.clone());
            tray::create(&handle)?;
            if std::env::args().any(|arg| arg == HIDDEN_FLAG)
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.hide();
            }
            let on_event: EventHook = Arc::new(notify::maybe_notify);
            tauri::async_runtime::spawn(engine.supervise(handle.clone(), launch, on_event));
            tauri::async_runtime::spawn(async move {
                if let Err(err) = peers.start().await {
                    log::error!("p2p start failed: {err}");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps sessions running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::engine_rpc,
            commands::engine_status,
            commands::peers_state,
            commands::peers_set_host_enabled,
            commands::peers_set_device_name,
            commands::peers_set_relay,
            commands::peers_create_pairing_code,
            commands::peers_pair_with,
            commands::peers_set_access,
            commands::peers_remove,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("Session Hub failed to start: {err}");
            std::process::exit(1);
        });
}
