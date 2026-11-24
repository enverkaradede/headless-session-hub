# Security model

Session Hub sits between Claude Code and a human. Answering a permission request **runs a command on
that machine**, so the design defaults to deny.

## Credentials and billing

- The app never stores or transports Anthropic credentials. Each machine's Claude Code uses its own login.
- Before every start and resume, `claude auth status` runs for the session's profile. Only `claude.ai` and
  `oauth_token` (subscription) logins start sessions. `api_key`, `api_key_helper` and `third_party` are
  refused unless the owner explicitly enables "Abonelik dışı girişe izin ver".
- The child environment is scrubbed of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, `AWS_BEARER_TOKEN_BEDROCK` and a stray `CLAUDE_CONFIG_DIR`.
  Callers cannot re-inject them through the session `env`.
- At runtime, a non-subscription `apiKeySource` in the `init` message aborts the session (`auth_blocked`).
- When a rate limit is hit, the session moves to `usage_limit` and the owner is notified. The run is
  interrupted, and nothing switches to an API key. With "pause on overage", a subscription that starts
  spending usage credits is also paused for the owner's decision.
- Tests: `test/manager.test.ts` ("refuses to start under an API-key login…", "aborts a session whose
  init reports an API key source", usage-limit and overage cases) and `test/claude.test.ts`.

## Permissions are never relaxed

- The SDK loads the user's own settings. Calls that settings already allow or deny never reach the app.
  Only calls that fall to "ask" reach a human.
- "Bu oturumda hep izin ver" forwards **only** `addRules` allow suggestions, rewritten to
  `destination: "session"`. The CLI also suggests `localSettings` (a persistent write), directory grants
  and `setMode: acceptEdits`; those are dropped (regression test in `manager.test.ts`).
- Sessions start only inside **allowed directories**. Paths are resolved with `realpath` and compared
  per platform; Windows comparison is case-insensitive. A prefix sibling such as `/srv/app-evil` does not
  match `/srv/app`.

## Who can do what

| Caller | Read | Drive sessions (start, message, answer, stop) | Settings, hooks |
|---|---|---|---|
| Local UI | ✓ | ✓ | ✓ |
| Local API / hubctl (token) | ✓ | ✓ | – |
| Paired device: read-only | ✓ | – | – |
| Paired device: operator | ✓ | ✓ | – |
| Paired device: full | ✓ | ✓ | ✓ |

- Access levels are chosen when pairing and changed later on the host. Changes apply to the next
  request, because they are re-read for every request.
- Pairing and access changes are **local-only**: a full-access device cannot pair new devices or
  raise anyone's level.
- The level is stamped by the host's shell from its own pairing store; a peer cannot claim one.
- Forbidden calls return `FORBIDDEN` and are written to the audit log (`rpc.forbidden`).
- Every start, message, answer, stop and settings change is audited with actor, time, session and request.

## Data leaving the device

- Everything sent to peers and webhooks is masked first (`src/masking.ts`):
  - JWTs and `Authorization`/Bearer headers
  - known token formats (Anthropic, GitHub, Slack, AWS, Google, GitLab, npm, PyPI, SendGrid)
  - private keys
  - passwords in connection strings and ADO.NET fields
  - `secret`/`token`/`password`-style assignments in JSON, env and YAML, including block-form YAML where the value sits on the next line
  - literal values of secret-named environment variables
- "Sadece özet gönder" (summary-only) mode keeps tool inputs, outputs and model text on the device.
- Webhook secrets never leave the device, not even to full-access peers.
- Timeline events are deleted after the retention period (default 30 days).
- `claude auth status` output carries the account email and organisation. Only the auth method and plan are kept.

## Transport

- **P2P:** iroh QUIC with TLS 1.3, dialed and authenticated by Ed25519 device keys.
  - Pairing codes are 128-bit, single-use and expire after 10 minutes.
  - Unpaired keys are rejected at connect time.
  - Relays see only ciphertext.
- **Local API:** bound to `127.0.0.1` with a random bearer token compared in constant time.
  - The token is regenerated each engine start and written to an owner-only `engine.json`.
  - Requests carrying an `Origin` header (browsers) are refused, and the `Host` header must be loopback (DNS rebinding).
- **Desktop webview:** strict CSP (`script-src 'self'`), frozen prototypes, no remote content.
  Markdown links open only as `http(s)` in the system browser.

## Compatibility-mode failure behaviour

`hubctl hook` exits 0 with no output whenever the engine is unreachable or slow. Claude Code then applies
its own default: in `-p` mode a permission request is **denied**, never allowed.
