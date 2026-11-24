//! hubctl — bridges Claude Code hooks and `claude -p` scripts to the local Session Hub engine.
//!
//! Commands:
//!   hubctl hook <Event> [--from-run]     read a hook payload on stdin, forward it, print the decision
//!   hubctl run [--name N] [--label L]... [--no-question-hint] -- <claude args>
//!   hubctl sessions [--status a,b] [--label L] [--json]
//!   hubctl requests [<session>] [--json]       what each waiting session is asking
//!   hubctl answer <session> <request> allow|allow-session|deny [--message M]
//!   hubctl answer <session> <request> --answer <choice> [--answer <choice>]...
//!   hubctl reply <session> <text>              answer a plain-text question / continue a session
//!   hubctl status
//! Session and request ids may be given as unique prefixes.

use std::env;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

mod inbox;

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
/// `claude -p` cannot use AskUserQuestion, so runs are told how to ask in a way the hub recognises.
const QUESTION_HINT: &str = "This run is unattended and supervised through Session Hub. If you need a decision or information from the user, finish your reply with exactly one clear question on its own last line, ending with a question mark, and stop.";
const APPEND_PROMPT_FLAG: &str = "--append-system-prompt";
const RESULT_REPORT_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound on the stdout kept to find the final result line of a JSON run.
const MAX_CAPTURED_OUTPUT: usize = 8 * 1024 * 1024;

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
pub(crate) fn api(method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<(u16, Value), String> {
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
    question_hint: bool,
    claude_args: Vec<OsString>,
}

fn parse_run_args(args: Vec<OsString>) -> Result<RunArgs, String> {
    let mut name = None;
    let mut labels = Vec::new();
    let mut question_hint = true;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.to_str() {
            Some("--") => return Ok(RunArgs { name, labels, question_hint, claude_args: iter.collect() }),
            Some("--no-question-hint") => question_hint = false,
            Some("--name") => name = Some(iter.next().ok_or("--name needs a value")?.to_string_lossy().into_owned()),
            Some("--label") => labels.push(iter.next().ok_or("--label needs a value")?.to_string_lossy().into_owned()),
            _ => return Err(format!("unexpected argument before --: {}", arg.to_string_lossy())),
        }
    }
    Err("usage: hubctl run [--name N] [--label L]... [--no-question-hint] -- <claude args>".to_owned())
}

/// Adds the question hint, merging with an --append-system-prompt the caller already passed.
fn with_question_hint(mut args: Vec<OsString>) -> Vec<OsString> {
    if let Some(index) = args.iter().position(|arg| arg == APPEND_PROMPT_FLAG)
        && let Some(existing) = args.get(index + 1)
    {
        let merged = format!("{}\n\n{QUESTION_HINT}", existing.to_string_lossy());
        args[index + 1] = OsString::from(merged);
        return args;
    }
    let prefix = format!("{APPEND_PROMPT_FLAG}=");
    if let Some(index) = args.iter().position(|arg| arg.to_string_lossy().starts_with(&prefix)) {
        let merged = format!("{}\n\n{QUESTION_HINT}", args[index].to_string_lossy());
        args[index] = OsString::from(merged);
        return args;
    }
    args.push(OsString::from(APPEND_PROMPT_FLAG));
    args.push(OsString::from(QUESTION_HINT));
    args
}

/// True when the run prints machine-readable JSON whose final result carries cost and usage.
fn json_output(args: &[OsString]) -> bool {
    args.windows(2).any(|pair| pair[0] == "--output-format" && (pair[1] == "json" || pair[1] == "stream-json"))
        || args.iter().any(|arg| arg == "--output-format=json" || arg == "--output-format=stream-json")
}

/// The CLI's final `{"type":"result",...}` object from captured stdout (json or stream-json).
fn final_result(output: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(output);
    if let Ok(value) = serde_json::from_str::<Value>(text.trim())
        && value.get("type").and_then(Value::as_str) == Some("result")
    {
        return Some(value);
    }
    text.lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value.get("type").and_then(Value::as_str) == Some("result"))
}

/// Sends cost and usage of a finished JSON run to the hub; best effort.
fn report_result(result: &Value, meta: &str) {
    let Some(session_id) = result.get("session_id").and_then(Value::as_str) else { return };
    let envelope = json!({
        "event": "RunResult",
        "entrypoint": "sdk-cli",
        "hubRun": serde_json::from_str::<Value>(meta).ok(),
        "payload": {
            "session_id": session_id,
            "hook_event_name": "RunResult",
            "total_cost_usd": result.get("total_cost_usd").cloned().unwrap_or(Value::Null),
            "modelUsage": result.get("modelUsage").cloned().unwrap_or(Value::Null),
        },
    });
    if let Err(err) = api("POST", "/v1/hooks", Some(&envelope), RESULT_REPORT_TIMEOUT) {
        eprintln!("hubctl: could not report the run result: {err}");
    }
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
    let claude_args = if parsed.question_hint { with_question_hint(parsed.claude_args) } else { parsed.claude_args };
    let capture = json_output(&claude_args);
    let mut command = Command::new(&claude);
    command.arg("--settings").arg(settings).args(&claude_args).env(RUN_HOOKS_ENV, "1").env(RUN_META_ENV, &meta);
    if capture {
        command.stdout(Stdio::piped());
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            eprintln!("hubctl: failed to start claude: {err}");
            return ExitCode::from(1);
        }
    };
    let mut captured = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        // Pass every byte through unchanged while keeping the tail to read the final result.
        let mut reader = BufReader::new(stdout);
        let mut out = io::stdout().lock();
        let mut line = Vec::new();
        while reader.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
            let _ = out.write_all(&line);
            let _ = out.flush();
            captured.extend_from_slice(&line);
            if captured.len() > MAX_CAPTURED_OUTPUT {
                let excess = captured.len() - MAX_CAPTURED_OUTPUT;
                captured.drain(..excess);
            }
            line.clear();
        }
    }
    let status = match child.wait() {
        Ok(status) => status,
        Err(err) => {
            eprintln!("hubctl: waiting for claude failed: {err}");
            return ExitCode::from(1);
        }
    };
    if let Some(result) = final_result(&captured) {
        report_result(&result, &meta);
    }
    ExitCode::from(status.code().and_then(|code| u8::try_from(code).ok()).unwrap_or(1))
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
    let mut as_json = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match (arg.as_str(), arg.as_str() == "--json") {
            (_, true) => as_json = true,
            ("--status", _) | ("--label", _) => match iter.next() {
                Some(value) => query.push(format!("{}={}", &arg[2..], encode(value))),
                None => {
                    eprintln!("usage: hubctl sessions [--status a,b] [--label L] [--json]");
                    return ExitCode::from(2);
                }
            },
            _ => {
                eprintln!("usage: hubctl sessions [--status a,b] [--label L] [--json]");
                return ExitCode::from(2);
            }
        }
    }
    let suffix = if query.is_empty() { String::new() } else { format!("?{}", query.join("&")) };
    inbox::sessions(&suffix, as_json)
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

fn strings(args: &[OsString]) -> Vec<String> {
    args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect()
}

fn usage() -> ExitCode {
    eprintln!(
        "usage:\n  hubctl run [--name N] [--label L]... [--no-question-hint] -- <claude args>\n  hubctl sessions [--status a,b] [--label L] [--json]\n  hubctl requests [<session>] [--json]\n  hubctl answer <session> <request> allow|allow-session|deny [--message M]\n  hubctl answer <session> <request> --answer <choice>...\n  hubctl reply <session> <text>\n  hubctl status\n  hubctl hook <Event>"
    );
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
        Some("sessions") => sessions(&strings(&args)),
        Some("requests") => {
            let args = strings(&args);
            let as_json = args.iter().any(|arg| arg == "--json");
            let session = args.iter().find(|arg| !arg.starts_with("--")).map(String::as_str);
            inbox::requests(session, as_json)
        }
        Some("answer") => inbox::answer(&strings(&args)),
        Some("reply") => inbox::reply(&strings(&args)),
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
    fn adds_the_question_hint_or_merges_it_into_an_existing_append_prompt() {
        let plain = with_question_hint(["-p", "x"].map(OsString::from).to_vec());
        assert_eq!(plain[2], OsString::from(APPEND_PROMPT_FLAG));
        assert_eq!(plain[3], OsString::from(QUESTION_HINT));
        let merged = with_question_hint(["-p", "x", "--append-system-prompt", "Be brief."].map(OsString::from).to_vec());
        assert_eq!(merged.len(), 4);
        assert!(merged[3].to_string_lossy().starts_with("Be brief.\n\n"));
        assert!(merged[3].to_string_lossy().ends_with(QUESTION_HINT));
    }

    #[test]
    fn finds_the_final_result_in_json_and_stream_json_output() {
        let json = br#"{"type":"result","session_id":"s","total_cost_usd":0.5}"#;
        assert_eq!(final_result(json).and_then(|v| v["total_cost_usd"].as_f64()), Some(0.5));
        let stream = b"{\"type\":\"system\"}\n{\"type\":\"result\",\"session_id\":\"s\",\"total_cost_usd\":0.25}\n";
        assert_eq!(final_result(stream).and_then(|v| v["total_cost_usd"].as_f64()), Some(0.25));
        assert!(final_result(b"plain text answer").is_none());
        assert!(json_output(&["-p", "x", "--output-format", "stream-json"].map(OsString::from)));
        assert!(!json_output(&["-p", "x"].map(OsString::from)));
    }

    #[test]
    fn percent_encodes_query_values() {
        assert_eq!(encode("waiting_input,done"), "waiting_input,done");
        assert_eq!(encode("ay şe"), "ay%20%C5%9Fe");
    }
}
