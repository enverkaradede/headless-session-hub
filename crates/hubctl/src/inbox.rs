//! Terminal side of the hub inbox: list sessions and what they are waiting for, answer, reply.

use std::process::ExitCode;
use std::time::Duration;

use serde_json::{json, Value};

use crate::api;

const TIMEOUT: Duration = Duration::from_secs(30);
const PREVIEW_LINES: usize = 12;
const WAITING_STATUSES: &str = "waiting_input,waiting_permission,deferred,usage_limit";

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("hubctl: {message}");
    ExitCode::from(1)
}

fn get(path: &str) -> Result<Value, String> {
    match api("GET", path, None, TIMEOUT)? {
        (200, body) => Ok(body),
        (status, body) => Err(format!("{status}: {}", error_text(&body))),
    }
}

fn post(path: &str, body: &Value) -> Result<Value, String> {
    match api("POST", path, Some(body), TIMEOUT)? {
        (200, body) => Ok(body),
        (status, body) => Err(format!("{status}: {}", error_text(&body))),
    }
}

fn error_text(body: &Value) -> String {
    body.pointer("/error/message").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| body.to_string())
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn last_segment(path: &str) -> &str {
    path.rsplit(['/', '\\']).find(|part| !part.is_empty()).unwrap_or(path)
}

/// Resolves a unique id prefix against a list of objects with an "id" field.
fn resolve<'a>(items: &'a [Value], prefix: &str, what: &str) -> Result<&'a Value, String> {
    let matches: Vec<&Value> = items.iter().filter(|item| text(item, "id").starts_with(prefix)).collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] => Err(format!("no {what} matches {prefix}")),
        _ => Err(format!("{prefix} matches several {what}s; give more characters")),
    }
}

fn find_session(prefix: &str) -> Result<Value, String> {
    let sessions = get("/v1/sessions")?;
    let list = sessions.as_array().cloned().unwrap_or_default();
    resolve(&list, prefix, "session").cloned()
}

// ── sessions ─────────────────────────────────────────────────────────────────

pub fn sessions(query: &str, as_json: bool) -> ExitCode {
    let body = match get(&format!("/v1/sessions{query}")) {
        Ok(body) => body,
        Err(err) => return fail(err),
    };
    if as_json {
        println!("{}", serde_json::to_string_pretty(&body).unwrap_or_default());
        return ExitCode::SUCCESS;
    }
    let list = body.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        println!("No sessions.");
        return ExitCode::SUCCESS;
    }
    println!("{:<9} {:<20} {:<40} PROJECT", "ID", "STATUS", "NAME");
    for session in &list {
        let mut status = text(session, "status").to_owned();
        if session.get("awaitingReply").and_then(Value::as_bool) == Some(true) {
            status.push_str(" (reply)");
        }
        let name: String = text(session, "name").chars().take(40).collect();
        println!("{:<9} {:<20} {:<40} {}", short(text(session, "id")), status, name, last_segment(text(session, "cwd")));
    }
    ExitCode::SUCCESS
}

// ── requests ─────────────────────────────────────────────────────────────────

fn open_requests(session_id: &str) -> Result<Vec<Value>, String> {
    let all = get(&format!("/v1/sessions/{session_id}/requests"))?;
    Ok(all
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|request| matches!(text(request, "state"), "open" | "deferred"))
        .collect())
}

fn print_request(session_id: &str, request: &Value) {
    let id = text(request, "id");
    let state = if text(request, "state") == "deferred" { " (deferred)" } else { "" };
    if text(request, "kind") == "question" {
        println!("  [question{state}] request {id}");
        let questions = request.get("questions").and_then(Value::as_array).cloned().unwrap_or_default();
        for (index, question) in questions.iter().enumerate() {
            let multi = if question.get("multiSelect").and_then(Value::as_bool) == Some(true) { "  (several allowed: 1,3)" } else { "" };
            println!("    Q{} [{}] {}{multi}", index + 1, text(question, "header"), text(question, "question"));
            for (number, option) in question.get("options").and_then(Value::as_array).cloned().unwrap_or_default().iter().enumerate() {
                let description = text(option, "description");
                let suffix = if description.is_empty() { String::new() } else { format!(" — {description}") };
                println!("      {}) {}{suffix}", number + 1, text(option, "label"));
            }
        }
        let flags = (1..=questions.len().max(1)).map(|n| format!("--answer <Q{n}>")).collect::<Vec<_>>().join(" ");
        println!("    → hubctl answer {} {} {flags}", short(session_id), short(id));
    } else {
        println!("  [permission{state}] {} request {id}", text(request, "toolName"));
        if let Some(path) = request.get("blockedPath").and_then(Value::as_str) {
            println!("    outside the working directory: {path}");
        }
        let preview = text(request, "inputPreview");
        for line in preview.lines().take(PREVIEW_LINES) {
            println!("    │ {line}");
        }
        if preview.lines().count() > PREVIEW_LINES {
            println!("    │ …");
        }
        println!("    → hubctl answer {} {} allow|allow-session|deny [--message \"why\"]", short(session_id), short(id));
    }
}

pub fn requests(session_prefix: Option<&str>, as_json: bool) -> ExitCode {
    let sessions = match session_prefix {
        Some(prefix) => match find_session(prefix) {
            Ok(session) => vec![session],
            Err(err) => return fail(err),
        },
        None => match get(&format!("/v1/sessions?status={WAITING_STATUSES}")) {
            Ok(body) => body.as_array().cloned().unwrap_or_default(),
            Err(err) => return fail(err),
        },
    };
    let mut output = Vec::new();
    for session in &sessions {
        let id = text(session, "id");
        match open_requests(id) {
            Ok(requests) => output.push((session.clone(), requests)),
            Err(err) => return fail(err),
        }
    }
    if as_json {
        let body: Vec<Value> = output.iter().map(|(session, requests)| json!({ "session": session, "requests": requests })).collect();
        println!("{}", serde_json::to_string_pretty(&body).unwrap_or_default());
        return ExitCode::SUCCESS;
    }
    let mut printed = false;
    for (session, requests) in &output {
        let awaiting_reply = session.get("awaitingReply").and_then(Value::as_bool) == Some(true);
        if requests.is_empty() && !awaiting_reply {
            continue;
        }
        printed = true;
        let id = text(session, "id");
        println!("● {}  ({})  {}", text(session, "name"), id, text(session, "status"));
        for request in requests {
            print_request(id, request);
        }
        if awaiting_reply {
            println!("  [reply] Claude asked in plain text:");
            println!("    │ {}", text(session, "lastMessagePreview"));
            println!("    → hubctl reply {} \"your answer\"", short(id));
        }
        println!();
    }
    if !printed {
        println!("Nothing is waiting for you.");
    }
    ExitCode::SUCCESS
}

// ── answer / reply ───────────────────────────────────────────────────────────

/// One --answer value: option numbers or labels (comma-separated for multi-select), otherwise free text.
fn choice_value(question: &Value, raw: &str) -> Value {
    let options: Vec<String> = question
        .get("options")
        .and_then(Value::as_array)
        .map(|options| options.iter().map(|option| text(option, "label").to_owned()).collect())
        .unwrap_or_default();
    let pick = |token: &str| -> Option<String> {
        let token = token.trim();
        if let Ok(number) = token.parse::<usize>()
            && number >= 1
            && number <= options.len()
        {
            return Some(options[number - 1].clone());
        }
        options.iter().find(|label| label.eq_ignore_ascii_case(token)).cloned()
    };
    let multi = question.get("multiSelect").and_then(Value::as_bool) == Some(true);
    if multi {
        let picks: Option<Vec<String>> = raw.split(',').map(pick).collect();
        if let Some(picks) = picks.filter(|picks| !picks.is_empty()) {
            return json!(picks);
        }
    } else if let Some(label) = pick(raw) {
        return json!(label);
    }
    json!(raw) // free text ("Other")
}

pub fn answer(args: &[String]) -> ExitCode {
    let [session_prefix, request_prefix, rest @ ..] = args else {
        return fail("usage: hubctl answer <session> <request> allow|allow-session|deny [--message M] | --answer <choice>...");
    };
    let session = match find_session(session_prefix) {
        Ok(session) => session,
        Err(err) => return fail(err),
    };
    let session_id = text(&session, "id").to_owned();
    let requests = match open_requests(&session_id) {
        Ok(requests) => requests,
        Err(err) => return fail(err),
    };
    let request = match resolve(&requests, request_prefix, "open request") {
        Ok(request) => request.clone(),
        Err(err) => return fail(err),
    };

    let mut message: Option<String> = None;
    let mut choices: Vec<String> = Vec::new();
    let mut decision: Option<String> = None;
    let mut iter = rest.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--message" => message = iter.next().cloned(),
            "--answer" => match iter.next() {
                Some(value) => choices.push(value.clone()),
                None => return fail("--answer needs a value"),
            },
            "allow" | "allow-session" | "deny" => decision = Some(arg.replace('-', "_")),
            other => return fail(format!("unexpected argument: {other}")),
        }
    }

    let answer = if text(&request, "kind") == "question" {
        let questions = request.get("questions").and_then(Value::as_array).cloned().unwrap_or_default();
        if choices.len() != questions.len() {
            return fail(format!("this request has {} question(s); give one --answer per question", questions.len()));
        }
        let mut answers = serde_json::Map::new();
        for (question, raw) in questions.iter().zip(&choices) {
            answers.insert(text(question, "question").to_owned(), choice_value(question, raw));
        }
        json!({ "kind": "question", "answers": answers })
    } else {
        let Some(decision) = decision else { return fail("say allow, allow-session or deny") };
        let mut body = json!({ "kind": "permission", "decision": decision });
        if let Some(message) = message {
            body["message"] = json!(message);
        }
        body
    };
    match post(&format!("/v1/sessions/{session_id}/answer"), &json!({ "requestId": text(&request, "id"), "answer": answer })) {
        Ok(_) => {
            println!("Answered. Session {} continues.", short(&session_id));
            ExitCode::SUCCESS
        }
        Err(err) => fail(err),
    }
}

pub fn reply(args: &[String]) -> ExitCode {
    let [session_prefix, words @ ..] = args else { return fail("usage: hubctl reply <session> <text>") };
    if words.is_empty() {
        return fail("usage: hubctl reply <session> <text>");
    }
    let session = match find_session(session_prefix) {
        Ok(session) => session,
        Err(err) => return fail(err),
    };
    let session_id = text(&session, "id");
    match post(&format!("/v1/sessions/{session_id}/message"), &json!({ "text": words.join(" ") })) {
        Ok(updated) => {
            println!("{}", reply_outcome(&updated, short(session_id)));
            ExitCode::SUCCESS
        }
        Err(err) => fail(err),
    }
}

/** A message to a session whose claude -p process is still running is queued, not sent; say which. */
fn reply_outcome(updated: &Value, short_id: &str) -> String {
    let queued = updated.get("queuedMessages").and_then(Value::as_array).map_or(0, Vec::len);
    if queued > 0 {
        format!("Queued ({queued} waiting). Session {short_id} continues with it when its current process ends.")
    } else {
        format!("Sent. Session {short_id} continues.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(multi: bool) -> Value {
        json!({ "question": "Which?", "header": "H", "multiSelect": multi, "options": [{ "label": "Red" }, { "label": "Blue" }, { "label": "Green" }] })
    }

    #[test]
    fn reply_says_whether_the_message_was_queued() {
        assert_eq!(reply_outcome(&json!({ "queuedMessages": [] }), "abcd1234"), "Sent. Session abcd1234 continues.");
        assert!(reply_outcome(&json!({ "queuedMessages": ["a", "b"] }), "abcd1234").starts_with("Queued (2 waiting)."));
        assert_eq!(reply_outcome(&json!({}), "abcd1234"), "Sent. Session abcd1234 continues.");
    }

    #[test]
    fn maps_numbers_and_labels_to_option_labels() {
        assert_eq!(choice_value(&question(false), "2"), json!("Blue"));
        assert_eq!(choice_value(&question(false), "green"), json!("Green"));
        assert_eq!(choice_value(&question(true), "1,3"), json!(["Red", "Green"]));
    }

    #[test]
    fn anything_else_is_free_text() {
        assert_eq!(choice_value(&question(false), "Mor olsun"), json!("Mor olsun"));
        assert_eq!(choice_value(&question(false), "9"), json!("9"));
    }

    #[test]
    fn resolves_unique_prefixes_only() {
        let items = vec![json!({ "id": "abc111" }), json!({ "id": "abd222" })];
        assert!(resolve(&items, "abc", "session").is_ok());
        assert!(resolve(&items, "ab", "session").is_err());
        assert!(resolve(&items, "zzz", "session").is_err());
    }
}
