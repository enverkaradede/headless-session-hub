# Setup

## Prerequisites (each machine that runs sessions)

1. **Claude Code**, installed with the native installer and logged in with a subscription. On Windows the
   executable must be the real `claude.exe` (usually `%USERPROFILE%\.local\bin\claude.exe`). npm
   `.cmd`/`.ps1` shims are ignored because they need a shell and mangle non-ASCII arguments.
2. The installed Session Hub app. It bundles its own Node runtime and `hubctl`, so nothing else is needed.

Several Claude logins on one machine (e.g. `CLAUDE_CONFIG_DIR=~/.claude-personal`) are set up as
**profiles** under Settings → General. Each profile's login is checked with `claude auth status` before
every session starts.

## Building the Windows installer (on the Windows machine)

```powershell
# one-time
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # Windows blocks scripts by default; pnpm and the signing helper need this
winget install OpenJS.NodeJS.LTS      # any Node >= 24 runs the build; the app itself always ships Node 24 LTS from nodejs.org
npm install -g pnpm@11
winget install Rustlang.Rustup        # rustup (NOT the standalone Rustlang.Rust.MSVC package); new window, then: rustup default stable
# Visual Studio Build Tools with the "Desktop development with C++" workload, and WebView2 (preinstalled on Windows 11)

# each build
git clone <repo> ; cd headless-session-hub
pnpm install
pnpm test
# set the updater signing key first (see docs/releasing.md), then:
pnpm bundle
pnpm release   # optional: publish to GitHub Releases for auto-update
```

### Building on Windows-on-ARM (e.g. VMware Fusion on an Apple Silicon Mac)

`pnpm bundle` targets **x86_64** on Windows by default. That installer runs natively on Intel/AMD PCs
and, emulated, on Windows-on-ARM. An ARM64 build would not run on an x64 PC, and it would also need `clang`.

On an ARM64 Windows build machine, add the x64 compilers once:

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" `
  --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --passive --norestart
```

To build for ARM64 instead (ARM devices only), install LLVM (`winget install LLVM.LLVM`) and run
`pnpm bundle --target aarch64-pc-windows-msvc`.

`pnpm bundle` runs `scripts/prepare-bundle.mjs`, which:
- builds the engine,
- downloads the latest Node 24 LTS `node.exe` for the target from nodejs.org, verifies it against `SHASUMS256.txt`, and puts it in `src-tauri/resources/node`. The build machine's own Node version does not matter,
- builds `hubctl.exe` and places it as a Tauri sidecar.

It then runs `tauri build` with `tauri.bundle.conf.json`. The NSIS installer (per-user, no admin) lands in
`target/x86_64-pc-windows-msvc/release/bundle/nsis/`.

> The installer is not code-signed yet, so Windows SmartScreen will warn on first run. Signing needs a certificate; see the Tauri docs on Windows code signing.

## First run

1. Settings → General: check the profile login (green "Subscription") and add the project folders
   sessions may run in (**allowed directories**).
2. Optional, Settings → General → "Girişte başlat": the app starts hidden in the tray at login.
3. Optional, Settings → Integrations: turn the hooks on per profile so unchanged `claude -p` scripts
   show up. Each hook runs `hubctl` only if it exists (`if [ -f '<hubctl>' ]; then … fi`), so moving or
   uninstalling the app never makes Claude sessions fail. On start the app re-points broken hooks at its
   own `hubctl`; hooks that run another install's existing `hubctl` are left alone. Claude Code runs hook
   commands in bash (Git Bash on Windows).

## Connecting devices (optional)

On the machine to be controlled (e.g. the office PC):
1. Settings → Devices → turn on **remote control**.
2. Pick the access level for the new device and press **Kod oluştur**.

On the controlling machine (e.g. home), paste the code under **Başka bir cihaza bağlan**.

The code is single-use and valid for 10 minutes. Afterwards the devices authenticate with their keys.
No port forwarding is needed: connections are direct where possible and go through an encrypted relay
otherwise (n0's public relays, or your own under Settings → Devices → Network).

## Data locations

| What | macOS | Windows |
|---|---|---|
| Engine DB, `engine.json` (API port + token), `peers.json`, device key | `~/Library/Application Support/dev.sessionhub.desktop` | `%APPDATA%\dev.sessionhub.desktop` |
| Engine log | `~/Library/Logs/dev.sessionhub.desktop/engine.log` | `%LOCALAPPDATA%\dev.sessionhub.desktop\logs\engine.log` |

`hubctl` finds the engine via `engine.json`. Override the location with `HUB_DATA_DIR`.
