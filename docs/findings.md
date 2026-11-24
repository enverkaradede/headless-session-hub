# Spike findings

Run on 2026-11-24 against Claude Code CLI **2.1.331** (native binary) and `@anthropic-ai/claude-agent-sdk` **0.3.331**, model `haiku`, macOS arm64.
Script: `packages/engine/spike/sdk-spike.mjs`. Raw reports land in `packages/engine/spike/out/` (git-ignored).

| # | Question | Result | Evidence |
|---|---|---|---|
| 1 | AskUserQuestion via `canUseTool`, single select, answer as label string | ✅ Works. Model received `blue`. | scenario `askSingle` |
| 2 | multiSelect answered with an array of labels | ✅ Works. Result `apple, plum`. Docs also accept a `", "`-joined string. | scenario `askMulti` |
| 3 | Permission deny: does the model get the message and continue? | ✅ Model replied `DENIED spike-denial-42`. | scenario `denyBash` |
| 4 | Is every tool call routed to `canUseTool`? | ❌ No. Calls already allowed by settings rules, and read-only Bash such as `echo`, never reach it, even with `settingSources: []`. Matches the product rule: only calls that fall to "ask" reach the human. | `denyBash` with `echo` |
| 5 | `canUseTool` `suggestions` shape | ⚠️ Includes `addRules` with `destination: "localSettings"` (a **persistent** write to the project settings), `addDirectories` and `setMode: acceptEdits`. "Allow for this session" must keep only `addRules`, rewrite them to `destination: "session"` and drop the rest. | `denyBash` with `touch` |
| 6 | PreToolUse `defer` from SDK hooks | ✅ Result `stop_reason: "tool_deferred"`, `terminal_reason: "tool_deferred"`, `deferred_tool_use: {id,name,input}`. Process ends. | `deferResume` first |
| 7 | Resume a deferred call through the SDK | ✅ Only if the input stream **stays open** until the result. The same `tool_use_id` re-fires PreToolUse, and `allow + updatedInput` delivers the answer. With an empty stream that closes immediately, stdin (the SDK control channel) closes, the hook cannot run, and the model sees the call as declined. | `deferResume` second, two runs |
| 8 | `pathToClaudeCodeExecutable` with the user's native binary + `CLAUDE_CONFIG_DIR` | ✅ Works. Session runs under that profile's login. `init.apiKeySource` = `none` for a claude.ai login. | all scenarios |
| 9 | `claude auth status` | ✅ JSON by default; exit 0 if logged in. `authMethod` ∈ `none, claude.ai, oauth_token, api_key, api_key_helper, third_party`. Output also carries **email and org name**: store only `authMethod` and `subscriptionType`. | manual run |
| 10 | Usage-limit hit | ⏳ Cannot be triggered on demand. The SDK types define `rate_limit_event.rate_limit_info.status: "allowed" \| "allowed_warning" \| "rejected"` with `resetsAt`, `rateLimitType`, `isUsingOverage`, and `TerminalReason` includes `blocking_limit`. The engine treats `status: "rejected"` as `usage_limit` and `isUsingOverage: true` as an overage stop. **Record the first real hit as a fixture.** | `sdk.d.ts` |
| 11 | `--permission-prompt-tool` input JSON | ⏭ Not needed: the SDK path uses `canUseTool`, compat mode uses hooks. Input schema still undocumented. | docs |
| 12 | Can stdin answer a pending request? | ⏭ Not needed: answers go through `canUseTool` / PreToolUse. | design |
| 13 | PermissionRequest hook long wait (compat mode) | ⏳ Default timeout 600 s, max undocumented. Test with `hubctl` in the compat phase. | docs |

| 14 | Subagent transcripts | ✅ With `forwardSubagentText: true`, subagent assistant/user messages arrive with `parent_tool_use_id` = the spawning `Agent` call (9 assistant + 5 user frames in the test run). `task_started` → `task_progress`* → `task_notification` bracket each subagent. **`task_progress` carries the live activity in `description` ("Reading a.txt"); `summary` was absent.** | `spike/subagent-spike.mjs` |
| 15 | Backgrounded subagents vs. streaming input | ❌→✅ A subagent can run in the background. The main turn then **emits a result before the subagent finishes** ("still reading…"). Closing the input on that result killed the subagent (0 transcript events). Fix: track `background_tasks_changed` (level signal, replace semantics, ignore `ambient`) and keep the process open while > 0. The CLI starts another turn when the work finishes. Verified: 15 subagent events, correct final answer. | `spike/engine-subagent-smoke.mjs`, `test/subagents.test.ts` |

## Environment notes

- This Mac runs two Claude accounts through `CLAUDE_CONFIG_DIR` (`~/.claude-work`, `~/.claude-personal`); `claude` itself is an alias. The app therefore supports **profiles** (name + config dir), and auth checks and hook installs happen per profile.
- The SDK loads the user's settings and MCP servers by default, so user-level hooks (e.g. other tools' PreToolUse hooks) run inside hub sessions too.
- `node:sqlite` works without a flag on Node 24/25, but prints an ExperimentalWarning. The engine wraps it behind a small repository layer.

## Design decisions driven by these findings

1. Questions and permissions: `canUseTool` (no stdin tricks, no `--permission-prompt-tool`).
2. Long waits: the PreToolUse hook returns `defer` once the wait policy expires. Resume keeps the input stream open until the deferred call is answered.
3. Session-scoped allow: filter `suggestions` to `addRules` → `destination: "session"`. Regression test: `test/permissions.test.ts`.
4. Auth gate: `claude auth status` before start, plus `init.apiKeySource` checked at runtime; auth env vars are stripped from the child environment.
