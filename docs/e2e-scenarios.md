# Manual end-to-end scenarios (real Claude login)

Run them before a release, on macOS and on the Windows machine. Use `--model haiku` / the "Model" field
where possible. Tick each box and note the date and platform.

`pnpm smoke -- <configDir>` automates scenario 1 and the API checks in scenario 9.

| # | Scenario | Steps | Expected |
|---|---|---|---|
| 1 | Question answering | New session: "Use AskUserQuestion to ask me red or blue, then reply with the colour." | Card appears ≤5 s after start (smoke: 3.7 s on macOS, 2026-11-24). Native notification shows if the window is unfocused. The answer continues the run, and the result shows the colour. |
| 2 | Permission deny | Prompt: "Run `touch marker.txt`". Choose **Reddet** with a message. | Model receives the message and continues. Timeline shows "İptal/Cevaplandı". |
| 3 | Allow for session | Same prompt twice in one session. Choose **Bu oturumda hep izin ver** the first time. | Second identical call is not asked. `.claude/settings.local.json` in the project is **not** modified. |
| 4 | Defer and resume | Settings → Davranış → "Sonra ertele", 1 minute. Ask a question and wait 1 minute. | Status `deferred` and the process is gone. Answering resumes the same session id with history kept. |
| 5 | deny_after | "Sonra reddet", 1 minute. | Request expires and the model gets the denial reason. |
| 6 | Compat mode | Settings → Entegrasyonlar: turn on hooks for a profile. In a terminal run `claude -p "touch x"` with that profile. | Session appears with the `-p` tag. The permission card appears, and allow/deny reaches the CLI. The status becomes `done` when the CLI exits. |
| 7 | hubctl run | `hubctl run --name demo --label ci -- -p "say hi"` | Listed as "demo" with label `ci` and registered only once (no duplicate from global hooks). |
| 8 | Interactive terminal ignored | With hooks installed, run plain `claude` interactively. | It does **not** appear in the list. (Assumes interactive entrypoint ≠ `sdk-*`. Verify!) |
| 9 | Local API | `curl` with and without a token, and with an `Origin` header. | 200 / 401 / 403. |
| 10 | Usage limit | When a real limit is hit (cannot be forced): | Status `usage_limit` with a reset time, and the webhook `session.usage_limit` fires. **Save the raw stream as a fixture** (`docs/findings.md` #10). |
| 11 | Auth guard | Start the app with `ANTHROPIC_API_KEY` set in its environment. | Sessions still run on the subscription (`init.apiKeySource = none`). |
| 12 | P2P pairing | Office: turn on remote control, set **Operatör**, create a code. Home: paste the code. | Home lists office sessions in their own group, and home can answer and start sessions. |
| 13 | Read-only peer | Change the home device to **Salt okunur** on the office machine. | Home's answer buttons are disabled. A forced call gets FORBIDDEN, and audit shows `rpc.forbidden`. |
| 14 | Full peer settings | Set the home device to **Tam yetkili**. | Home can edit office settings (Settings → device picker). Webhook secrets show as redacted. |
| 15 | Turkish user path | Windows user `AyşeŞahin`, a project under `C:\Users\AyşeŞahin\Projeler\çalışma`. | Start, answer and resume work, and paths display correctly. |
| 16 | Tray life cycle | Close the window while a session runs. Then use tray → Quit. | Session keeps running after the window closes. Quit asks for confirmation while sessions are live. |
| 18 | Subagent view | Prompt: "Use the Agent tool to read every .txt file here and report." | A violet subagent card shows live activity ("Reading a.txt"). Clicking it morphs into its own conversation pane with a breadcrumb; Esc returns. The session stays `running` until the subagent reports back. |
| 19 | Auto-update | Public repo only: install vN, publish vN+1 with `pnpm release`. | Settings → Hakkında → "Şimdi denetle" finds vN+1. The sidebar shows the update pill, then download progress, then "Yeniden başlat". The new version is shown after relaunch. |
| 17 | Engine crash | Kill the `node` engine process. | UI shows "Motor yeniden başlıyor". The engine is back within seconds, and orphaned sessions show `engine_restart`. |
