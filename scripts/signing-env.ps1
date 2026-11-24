# Loads the updater signing key into THIS PowerShell window, for `pnpm bundle`.
# Works on Windows PowerShell 5.1 and PowerShell 7.
#
#   . .\scripts\signing-env.ps1          # note the leading dot: the variables must stay in your window
#
# The key is read from %USERPROFILE%\.session-hub\updater.key; the password is typed (hidden) and
# never written to disk. Close the window and both are gone.
param(
  [string]$KeyPath = (Join-Path $HOME ".session-hub\updater.key")
)

if (-not (Test-Path -LiteralPath $KeyPath)) {
  Write-Error "Signing key not found at $KeyPath. Copy updater.key there first (docs/releasing.md)."
  return
}

$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw -LiteralPath $KeyPath

$secure = Read-Host "Updater key password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

Write-Host "Signing key loaded for this window only. Next: pnpm bundle"
