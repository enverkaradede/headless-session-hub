//! hubctl — bridges Claude Code hooks and `claude -p` scripts to the local Session Hub engine.
//!
//! Commands:
//!   hubctl hook <Event> [--from-run]     read a hook payload on stdin, forward it, print the decision
//!   hubctl run [--name N] [--label L]... -- <claude args>
//!   hubctl sessions [--status a,b] [--label L]
//!   hubctl status

use std::env;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

const APP_IDENTIFIER: &str = "dev.sessionhub.desktop";
const DISCOVERY_FILE: &str = "engine.json";
/// PermissionRequest hooks time out at 600 s; stop just after the engine's own 570 s budget.
const PERMISSION_TIMEOUT: Duration = Duration::from_secs(590);
const STATUS_TIMEOUT: Duration = Duration::from_secs(8);
const API_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HOOK_INPUT_BYTES: u64 = 4 * 1024 * 1024;
/// Set by `hubctl run`; globally installed hooks then step aside for the run's own injected hooks.
const RUN_HOOKS_ENV: &str = "HUB_RUN_HOOKS";
const RUN_META_ENV: &str = "HUB_RUN_META";
const HOOK_EVENTS: [&str; 5] = ["SessionStart", "SessionEnd", "Stop", "Notification", "PermissionRequest"];

#[derive(Deserialize)]
struct Discovery {
    port: u16,
    token: String,
}

fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = env::var_os("HUB_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    dirs::data_dir().map(|dir| dir.join(APP_IDENTIFIER))
}

fn discover() -> Result<Discovery, String> {
    let dir = data_dir().ok_or("cannot determine the Session Hub data directory")?;
    let raw = std::fs::read(dir.join(DISCOVERY_FILE)).map_err(|_| "Session Hub is not running (no engine.json)".to_owned())?;
    serde_json::from_slice(&raw).map_err(|err| format!("engine.json is unreadable: {err}"))
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into()
}

/// One call to the local API. Returns (status, body).
fn api(method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<(u16, Value), String> {
    let discovery = discover()?;
    let url = format!("http://127.0.0.1:{}{}", discovery.port, path);
    let auth = format!("Bearer {}", discovery.token);
    let agent = agent(timeout);
    let response = match (method, body) {
        ("GET", _) => agent.get(&url).header("Authorization", &auth).call(),
        (_, Some(payload)) => agent.post(&url).header("Authorization", &auth).send_json(payload),
        (_, None) => agent.post(&url).header("Authorization", &auth).send_empty(),
    };
    let mut response = response.map_err(|err| format!("request failed: {err}"))?;
    let status = response.status().as_u16();
    let value = response.body_mut().read_json::<Value>().unwrap_or(Value::Null);
    Ok((status, value))
}

// ── hook ─────────────────────────────────────────────────────────────────────

/// Forwards one hook event. Every failure path prints nothing and exits 0, so Claude Code falls
/// back to its own behaviour (a permission request in -p mode is then denied, never allowed).
fn hook(event: &str, from_run: bool) -> ExitCode {
    if !HOOK_EVENTS.contains(&event) {
        eprintln!("hubctl: unknown hook event {event}");
        return ExitCode::SUCCESS;
    }
    if env::var_os(RUN_HOOKS_ENV).is_some() && !from_run {
        return ExitCode::SUCCESS; // `hubctl run` injected its own hooks for this process
    }
    let mut raw = Vec::new();
    if io::stdin().take(MAX_HOOK_INPUT_BYTES).read_to_end(&mut raw).is_err() {
        return ExitCode::SUCCESS;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&raw) else { return ExitCode::SUCCESS };
    let run_meta = env::var(RUN_META_ENV).ok().and_then(|meta| serde_json::from_str::<Value>(&meta).ok());
    let envelope = json!({
        "event": event,
        "entrypoint": env::var("CLAUDE_CODE_ENTRYPOINT").ok(),
        "hubRun": run_meta,
        "payload": payload,
    });
    let timeout = if event == "PermissionRequest" { PERMISSION_TIMEOUT } else { STATUS_TIMEOUT };
    match api("POST", "/v1/hooks", Some(&envelope), timeout) {
        Ok((200, decision)) if decision.as_object().is_some_and(|object| !object.is_empty()) => {
            let mut stdout = io::stdout().lock();
            let _ = writeln!(stdout, "{decision}");
        }
        Ok((200, _)) => {}
        Ok((status, body)) => eprintln!("hubctl: engine answered {status}: {body}"),
        Err(err) => eprintln!("hubctl: {err}"),
    }
    ExitCode::SUCCESS
}

// ── run ──────────────────────────────────────────────────────────────────────

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// The real claude executable. `.cmd`/`.ps1` shims are skipped: they need a shell and mangle non-ASCII args.
fn find_claude() -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("HUB_CLAUDE_PATH") {
        return Some(PathBuf::from(explicit));
    }
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let mut candidates = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local").join("bin").join(exe));
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|dir| dir.join(exe)));
    }
    candidates.into_iter().find(|candidate| is_executable_file(candidate))
}

fn self_command(event: &str) -> Result<String, String> {
    let exe = env::current_exe().map_err(|err| format!("cannot locate hubctl: {err}"))?;
    let path = exe.to_string_lossy().replace('\\', "/");
    Ok(format!("\"{path}\" hook {event} --from-run"))
}

fn injected_settings() -> Result<String, String> {
    let mut hooks = serde_json::Map::new();
    for event in HOOK_EVENTS {
        let timeout = if event == "PermissionRequest" { 600 } else { 10 };
        let mut entry = json!({ "hooks": [{ "type": "command", "command": self_command(event)?, "timeout": timeout }] });
        if event == "PermissionRequest" {
            entry["matcher"] = json!("*");
        }
        hooks.insert(event.to_owned(), json!([entry]));
    }
    Ok(json!({ "hooks": hooks }).to_string())
}

struct RunArgs {
    name: Option<String>,
    labels: Vec<String>,
    claude_args: Vec<OsString>,
}

fn parse_run_args(args: Vec<OsString>) -> Result<RunArgs, String> {
    let mut name = None;
    let mut labels = Vec::new();
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.to_str() {
            Some("--") => return Ok(RunArgs { name, labels, claude_args: iter.collect() }),
            Some("--name") => name = Some(iter.next().ok_or("--name needs a value")?.to_string_lossy().into_owned()),
            Some("--label") => labels.push(iter.next().ok_or("--label needs a value")?.to_string_lossy().into_owned()),
            _ => return Err(format!("unexpected argument before --: {}", arg.to_string_lossy())),
        }
    }
    Err("usage: hubctl run [--name N] [--label L]... -- <claude args>".to_owned())
}

fn run(args: Vec<OsString>) -> ExitCode {
    let parsed = match parse_run_args(args) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!("hubctl: {err}");
            return ExitCode::from(2);
        }
    };
    let Some(claude) = find_claude() else {
        eprintln!("hubctl: claude executable not found (set HUB_CLAUDE_PATH)");
        return ExitCode::from(127);
    };
    let settings = match injected_settings() {
        Ok(settings) => settings,
        Err(err) => {
            eprintln!("hubctl: {err}");
            return ExitCode::from(1);
        }
    };
    let meta = json!({ "name": parsed.name, "labels": parsed.labels }).to_string();
    let status = Command::new(&claude)
        .arg("--settings")
        .arg(settings)
        .args(&parsed.claude_args)
        .env(RUN_HOOKS_ENV, "1")
        .env(RUN_META_ENV, meta)
        .status();
    match status {
        Ok(status) => ExitCode::from(status.code().and_then(|code| u8::try_from(code).ok()).unwrap_or(1)),
        Err(err) => {
            eprintln!("hubctl: failed to start claude: {err}");
            ExitCode::from(1)
        }
    }
}

// ── sessions / status ────────────────────────────────────────────────────────

fn print_api(method: &str, path: &str) -> ExitCode {
    match api(method, path, None, API_TIMEOUT) {
        Ok((200, body)) => {
            println!("{}", serde_json::to_string_pretty(&body).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Ok((status, body)) => {
            eprintln!("hubctl: {status}: {body}");
            ExitCode::from(1)
        }
        Err(err) => {
            eprintln!("hubctl: {err}");
            ExitCode::from(1)
        }
    }
}

fn sessions(args: &[String]) -> ExitCode {
    let mut query = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match (arg.as_str(), iter.next()) {
            ("--status", Some(value)) => query.push(format!("status={}", encode(value))),
            ("--label", Some(value)) => query.push(format!("label={}", encode(value))),
            _ => {
                eprintln!("usage: hubctl sessions [--status a,b] [--label L]");
                return ExitCode::from(2);
            }
        }
    }
    let suffix = if query.is_empty() { String::new() } else { format!("?{}", query.join("&")) };
    print_api("GET", &format!("/v1/sessions{suffix}"))
}

/// Minimal percent-encoding for query values.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b',' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn usage() -> ExitCode {
    eprintln!("usage: hubctl <hook <Event> | run [--name N] [--label L]... -- <claude args> | sessions [--status s] [--label l] | status>");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let mut args: Vec<OsString> = env::args_os().skip(1).collect();
    if args.is_empty() {
        return usage();
    }
    let command = args.remove(0);
    match command.to_str() {
        Some("hook") => {
            let event = args.first().map(|arg| arg.to_string_lossy().into_owned()).unwrap_or_default();
            let from_run = args.iter().any(|arg| arg == "--from-run");
            hook(&event, from_run)
        }
        Some("run") => run(args),
        Some("sessions") => sessions(&args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>()),
        Some("status") => print_api("GET", "/v1/info"),
        _ => usage(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_run_args_up_to_the_separator() {
        let args = ["--name", "nightly", "--label", "ci", "--", "-p", "çalıştır", "--resume"].map(OsString::from).to_vec();
        let parsed = parse_run_args(args).expect("valid args");
        assert_eq!(parsed.name.as_deref(), Some("nightly"));
        assert_eq!(parsed.labels, vec!["ci"]);
        assert_eq!(parsed.claude_args, ["-p", "çalıştır", "--resume"].map(OsString::from).to_vec());
    }

    #[test]
    fn rejects_run_without_separator() {
        assert!(parse_run_args(vec![OsString::from("-p")]).is_err());
    }

    #[test]
    fn injected_settings_contain_every_hook_with_from_run() {
        let settings: Value = serde_json::from_str(&injected_settings().expect("settings")).expect("json");
        for event in HOOK_EVENTS {
            let command = settings["hooks"][event][0]["hooks"][0]["command"].as_str().expect("command");
            assert!(command.ends_with(&format!("hook {event} --from-run")), "{command}");
        }
        assert_eq!(settings["hooks"]["PermissionRequest"][0]["matcher"], "*");
    }

    #[test]
    fn percent_encodes_query_values() {
        assert_eq!(encode("waiting_input,done"), "waiting_input,done");
        assert_eq!(encode("ay şe"), "ay%20%C5%9Fe");
    }
}
