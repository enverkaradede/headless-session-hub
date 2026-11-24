//! Tray icon: the app lives here when its window is closed; quitting asks first if sessions are live.

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::engine::EngineHandle;

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open Session Hub", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Session Hub")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { confirm_quit(app).await });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Quitting kills the engine and every live session it owns, so ask when any are running.
async fn confirm_quit(app: AppHandle) {
    let engine = app.state::<EngineHandle>().inner().clone();
    let live = engine
        .rpc("sessions.list", json!({}), json!({ "kind": "local" }))
        .await
        .ok()
        .and_then(|value| value.as_array().map(|sessions| sessions.iter().filter(|s| s.get("live").and_then(Value::as_bool) == Some(true)).count()))
        .unwrap_or(0);
    if live == 0 {
        app.exit(0);
        return;
    }
    let message = format!("{live} session(s) are still running. Quitting stops them. Quit anyway?");
    app.dialog()
        .message(message)
        .title("Quit Session Hub")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Keep running".into()))
        .show(move |quit| {
            if quit {
                app.exit(0);
            }
        });
}
