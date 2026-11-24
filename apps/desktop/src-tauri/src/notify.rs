//! Native notifications for engine `notify` events, shown only when the window is not in front.

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

pub fn maybe_notify(app: &AppHandle, event: &Value) {
    if event.get("type").and_then(Value::as_str) != Some("notify") {
        return;
    }
    let focused = app.get_webview_window("main").and_then(|window| window.is_focused().ok()).unwrap_or(false);
    if focused {
        return;
    }
    let title = event.get("title").and_then(Value::as_str).unwrap_or("Session Hub");
    let body = event.get("body").and_then(Value::as_str).unwrap_or_default();
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        log::warn!("notification failed: {err}");
    }
}
