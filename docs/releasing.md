# Versioning, releases and auto-update

## How updates reach users

- `tauri-plugin-updater` reads the manifest at
  `https://github.com/enverkaradede/headless-session-hub/releases/latest/download/latest.json`.
- Every installer is **signed** with the updater key. The app checks the signature against the public key
  in `tauri.conf.json` and refuses anything that does not match.
- The app checks quietly 8 s after start and every 6 hours. The user can turn this off under
  Settings → About. Installing always needs the user's click.
- **While the repository is private**, release assets are not publicly downloadable. The check then ends
  as "unreachable", silently. Make the repository public and existing installs start updating at their
  next check. Nothing else changes.

## Version

`apps/desktop/package.json` is the single source of truth:
- `tauri.conf.json` reads it,
- the engine bundle injects it,
- `scripts/version.mjs` copies it into the other `package.json` files and both `Cargo.toml` files.

```bash
pnpm version:bump patch        # or minor | major | 1.4.0
# edit CHANGELOG.md (the bump drafts it from commit subjects)
git commit -am "chore(release): v0.1.1" && git tag v0.1.1 && git push --follow-tags
```

The CHANGELOG section of a version becomes the release notes and the text shown in the in-app update dialog.

## Signing key

| What | Where |
|---|---|
| Private key | `~/.config/session-hub/updater.key` on the Mac (mode 600). Never commit it. |
| Key password | macOS Keychain, service `session-hub-updater-key-password` |
| Public key | `apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (safe to commit) |

**Losing the private key means existing installs can never update again** (they only trust this key).
Keep a copy in your password manager.

### Using the key on the Windows VM

Two things are needed for signing:
- the **key file** (`updater.key`), and
- its **password**.

The file is moved once. The password is typed at each build and never saved on the VM.

**One-time: move the key file to the VM**

1. In VMware, open VM → Settings → Options → Shared Folders. Share a Mac folder, e.g. `~/VMShare`.
2. On the Mac: `cp ~/.config/session-hub/updater.key ~/VMShare/`
3. In the VM's PowerShell:
   ```powershell
   New-Item -ItemType Directory -Force "$HOME\.session-hub" | Out-Null
   Copy-Item "\\vmware-host\Shared Folders\VMShare\updater.key" "$HOME\.session-hub\updater.key"
   ```
4. Back on the Mac, remove the copy from the share: `rm ~/VMShare/updater.key`

**Each build: load the key into the PowerShell window**

1. On the Mac, copy the password to the clipboard. It is not shown on screen, and VMware's shared
   clipboard carries it into the VM:
   `security find-generic-password -s session-hub-updater-key-password -w | pbcopy`
2. In the VM, from the repo folder:
   ```powershell
   . .\scripts\signing-env.ps1      # the leading dot matters; paste the password when asked
   ```
   The key stays loaded only in that window. Closing it forgets both the key and the password.

> This signature is the **update signature**: installed apps accept an update only if it was signed with
> this key. It is not Windows code signing, which removes the SmartScreen warning. That needs a
> certificate and is a separate, optional step.

## Release on Windows

```powershell
git pull --tags
pnpm install
pnpm test
. .\scripts\signing-env.ps1
pnpm bundle      # x64 by default; builds and signs target\x86_64-pc-windows-msvc\release\bundle\nsis\Session Hub_<v>_x64-setup.exe + .sig
pnpm release     # creates/updates GitHub Release v<v>, uploads the installer and latest.json
```

`pnpm release` merges into an existing `latest.json`. A macOS build published to the same tag later
(`pnpm bundle && pnpm release` on the Mac) adds `darwin-*` next to `windows-x86_64`.

## Release on macOS

The key file and its Keychain password go straight into the build's environment; neither is printed.

```bash
git pull --tags && pnpm install && pnpm test
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.config/session-hub/updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s session-hub-updater-key-password -w)" \
pnpm bundle      # Apple Silicon by default; target/aarch64-apple-darwin/release/bundle/{dmg,macos}
pnpm release     # adds darwin-aarch64 to the same GitHub Release and latest.json
```

Both platforms bundle the latest Node 24 LTS from nodejs.org (checked against SHASUMS256), never the build
machine's own Node.

The app is not signed with an Apple Developer ID. A downloaded `.dmg` therefore opens only after
right-click → Open (or `xattr -dr com.apple.quarantine "/Applications/Session Hub.app"`). In-app updates
are verified with the updater key and do not need this.

## Checklist per release

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint:rust` green
- [ ] Version bumped, CHANGELOG written in user-facing language
- [ ] Bundle signed (`.sig` next to the installer)
- [ ] `pnpm release` done; `latest.json` lists every shipped platform
- [ ] An older install sees the update under Settings → About → "Şimdi denetle" (public repo only)
