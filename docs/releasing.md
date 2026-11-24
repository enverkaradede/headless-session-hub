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

1. On the Mac, copy the key into a VMware shared folder or onto a USB stick. Read the password yourself:
   `security find-generic-password -s session-hub-updater-key-password -w`
2. In the VM's PowerShell, for the build session only:
   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$HOME\.session-hub\updater.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-Host -AsSecureString "Key password" | ConvertFrom-SecureString -AsPlainText
   ```
   Keep the key file under your user profile (e.g. `%USERPROFILE%\.session-hub\`), not in the repo and not left in the shared folder.

## Release on Windows

```powershell
git pull --tags
pnpm install
pnpm test
pnpm bundle      # builds and signs: target\release\bundle\nsis\Session Hub_<v>_x64-setup.exe + .sig
pnpm release     # creates/updates GitHub Release v<v>, uploads the installer and latest.json
```

`pnpm release` merges into an existing `latest.json`. A macOS build published to the same tag later
(`pnpm bundle && pnpm release` on the Mac) adds `darwin-*` next to `windows-x86_64`.

## Checklist per release

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint:rust` green
- [ ] Version bumped, CHANGELOG written in user-facing language
- [ ] Bundle signed (`.sig` next to the installer)
- [ ] `pnpm release` done; `latest.json` lists every shipped platform
- [ ] An older install sees the update under Settings → About → "Şimdi denetle" (public repo only)
