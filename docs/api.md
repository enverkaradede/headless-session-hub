# Local API and hubctl

The engine listens on `127.0.0.1:<port>`. Port and token are in `engine.json` in the app data directory
(see [setup](setup.md#data-locations)). Every request except `GET /v1/health` needs
`Authorization: Bearer <token>`. Browser-originated requests (any `Origin` header) are refused.

Errors use the body `{ "error": { "code", "message" } }`:

| Code | HTTP |
|---|---|
| `BAD_REQUEST` | 400 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409, e.g. a request that was already answered |
| `DIRECTORY_NOT_ALLOWED` | 403 |
| `AUTH_BLOCKED` | 412, the profile is not on a subscription login |
| `CLAUDE_NOT_FOUND` | 424 |

## Endpoints

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /v1/health` | – | `{ ok: true }` |
| `GET /v1/info` | – | engine info: version, claude version, auth per profile |
| `GET /v1/sessions` | `?status=a,b&label=x` | `SessionSummary[]` |
| `POST /v1/sessions` | `StartSessionParams` (below) | `SessionSummary` |
| `GET /v1/sessions/:id` | – | `SessionSummary` |
| `PATCH /v1/sessions/:id` | `{ name?, labels? }` | `SessionSummary` |
| `GET /v1/sessions/:id/timeline` | `?after=<seq>` | `TimelineEvent[]` |
| `GET /v1/sessions/:id/requests` | – | `PendingRequest[]` |
| `POST /v1/sessions/:id/answer` | `{ requestId, answer }` | `PendingRequest` |
| `POST /v1/sessions/:id/message` | `{ text }` | `SessionSummary`; never refused for being busy (see [Messages](#messages)) |
| `POST /v1/sessions/:id/resume` | `{ text? }` | as `message`, default text "Continue where you left off." |
| `POST /v1/sessions/:id/stop` | – | `SessionSummary`; also drops queued messages |
| `DELETE /v1/sessions/:id/queue` | – | `SessionSummary`; drops queued messages without sending them |
| `POST /v1/hooks` | used by `hubctl hook` | hook decision |

### StartSessionParams

```jsonc
{
  "cwd": "/abs/path/inside/an/allowed/directory",   // required
  "prompt": "Run the tests and fix what breaks",    // required
  "name": "nightly", "labels": ["ci"],
  "profileId": "default",
  "appendSystemPrompt": "…",
  "permissionMode": "auto",             // auto | default | acceptEdits | plan | dontAsk; omitted: the settings default (auto)
  "model": "sonnet",
  "allowedTools": ["Read", "Bash(npm test:*)"], "disallowedTools": ["WebFetch"],
  "env": { "FEATURE_FLAG": "1" },        // auth/provider variables are rejected
  "maxTurns": 50, "maxBudgetUsd": 5,
  "waitPolicy": { "mode": "defer_after", "minutes": 30 }   // wait | deny_after | defer_after
}
```

### Answers

```jsonc
// AskUserQuestion: keyed by the question text; multiSelect → array; free text → plain string
{ "kind": "question", "answers": { "Which colour?": "blue", "Which fruits?": ["apple", "plum"] } }
// permission
{ "kind": "permission", "decision": "allow" | "allow_session" | "deny", "message": "optional, for deny" }
```

### Messages

Input is never locked, as in Claude Code itself. What a message does depends on the session:

| Session state | Effect |
|---|---|
| Live hub process, a question or permission card is open | The message answers the card: the tool call is declined and Claude gets the text as the user's reply in the same turn |
| Live hub process, no card | Written straight into the running process |
| External `claude -p` process running, permission pending | Answers the permission the same way |
| External `claude -p` process running, nothing pending | Queued (`queuedMessages`); when the process ends, the session resumes in the hub with all queued messages in order |
| Hub process closing | Queued; sent as soon as it has closed |
| Closed | Resumes with `--resume` (plus anything queued before) |

If queued messages cannot be sent (directory no longer allowed, auth guard, the run ended in an error or usage limit),
they stay in the queue and a notice says why; the next message sends them together with it.

### Statuses

`starting · running · waiting_input · waiting_permission · idle · done · error · usage_limit · deferred`

`waiting_input` with `awaitingReply: true` means the turn ended on a **plain-text question** (no card).
Answer it with `POST /v1/sessions/:id/message` (or `hubctl reply`); the session resumes.

`endReason`: `completed · stopped_by_user · error · usage_limit · auth_blocked · max_turns · budget_exhausted · engine_restart · process_exit`

## Outgoing webhooks

The engine sends `POST <url>` with `content-type: application/json` and these headers:
- `x-session-hub-timestamp: <unix seconds>`
- `x-session-hub-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`

Verify the signature and reject timestamps that are too old. Failed deliveries are retried 4 times with jittered backoff (1 s, 4 s, 16 s). A 4xx response other than 408/429 is not retried.

```json
{
  "event": "session.completed",
  "device": "OFFICE-PC",
  "sentAt": "2026-11-24T12:00:00.000Z",
  "session": {
    "id": "…", "name": "nightly", "labels": ["ci"], "status": "done", "endReason": "completed",
    "origin": "app", "costUsd": 0.42, "inputTokens": 120000, "outputTokens": 8000,
    "usageLimit": null, "lastMessage": "masked final message"
  }
}
```

Events: `session.started`, `session.waiting`, `session.completed`, `session.error`, `session.usage_limit`, `session.deferred`.
A queue service stops its queue on `session.usage_limit`.

## hubctl

```bash
hubctl run [--name N] [--label L]... [--no-question-hint] -- <claude args>   # instead of `claude`
hubctl sessions [--status waiting_input,waiting_permission] [--label ci] [--json]
hubctl requests [<session>] [--json]          # what is being asked: commands, questions, options
hubctl answer <session> <request> allow|allow-session|deny [--message "why"]
hubctl answer <session> <request> --answer 2 [--answer "1,3"]...   # one per question; number, label or free text
hubctl reply <session> "use the staging config"                   # plain-text questions
hubctl status
hubctl hook <Event>                                     # used by installed hooks; reads the payload on stdin
```

Session and request ids accept unique prefixes (e.g. `3f2a`).

`hubctl run` also tells the model to end with one clear question when it needs you, because `-p` runs
have no AskUserQuestion tool. Merge or skip this with `--no-question-hint`. With `--output-format json`
or `stream-json`, it forwards the final result's cost and usage to the hub; output passes through unchanged.

`hubctl run` passes the run's own hooks through `--settings`. If the hooks are also installed globally,
the global copies step aside for that process, so nothing registers twice.
