# Session Hub

A desktop app (Tauri v2 + React + Tailwind) that runs and supervises **headless Claude Code sessions**.
It brings their questions (`AskUserQuestion`) and permission prompts to you instead of letting
`claude -p` runs fail or decide on their own.

- Every install manages the sessions on its own machine. The left panel lists them like chats, and sessions waiting for you come first.
- Sessions you start from the app are fully controllable: answer, message, stop, and resume after a finished run.
- Existing `claude -p` scripts appear once you install the hooks or run them through `hubctl run`.
- Remote control between your devices is optional and peer-to-peer (iroh). Each paired device gets its own access level: read-only, operator or full.
- Local REST API, `hubctl` CLI and signed outgoing webhooks are available for automations.

## Layout

| Path | What |
|---|---|
| `apps/desktop` | Tauri shell (Rust) and React UI |
| `apps/desktop/src-tauri/src/engine.rs` | Supervises the Node engine sidecar; JSON-lines RPC bridge |
| `apps/desktop/src-tauri/src/peers.rs` | Optional P2P: pairing, access levels, host/client links |
| `packages/engine` | Node engine: Agent SDK sessions, `canUseTool`, SQLite, local API, hooks, webhooks, masking |
| `packages/protocol` | Shared zod contract (engine ↔ UI ↔ peers) |
| `crates/hubctl` | CLI: hook bridge, `claude -p` wrapper, API client |
| `docs/` | [setup](docs/setup.md), [security model](docs/security-model.md), [API](docs/api.md), [spike findings](docs/findings.md), [manual E2E scenarios](docs/e2e-scenarios.md) |

## Quick start (development, macOS or Windows)

```bash
pnpm install
pnpm dev          # builds the engine + hubctl, then `tauri dev`
pnpm test         # engine (vitest) + hubctl (cargo test)
pnpm typecheck && pnpm lint:rust
pnpm smoke -- ~/.claude   # end-to-end against the real CLI (uses a few cents of haiku)
```

Requirements: Node 24+, pnpm 11, Rust stable, and Claude Code installed and logged in.
See [docs/setup.md](docs/setup.md) for the Windows build.
