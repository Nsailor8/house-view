# Starts House View locally against the real Home Assistant.
# No secrets or IPs in this file. They live outside the repo in %USERPROFILE%\.house-view\
#   token   - HA long-lived token, encrypted with Windows DPAPI (only your Windows user can read it)
#   ha_url  - e.g. http://<HAOS IP>:8123
# One-time setup: see CLAUDE.md, "Local dev".
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File .\dev.ps1

$cfg = Join-Path $env:USERPROFILE '.house-view'
$tokenFile = Join-Path $cfg 'token'
$urlFile = Join-Path $cfg 'ha_url'

if (-not (Test-Path $tokenFile) -or -not (Test-Path $urlFile)) {
  Write-Error "Missing $tokenFile or $urlFile. Do the one-time setup in CLAUDE.md."
  exit 1
}

$secure = Get-Content $tokenFile | ConvertTo-SecureString
$env:HA_TOKEN = [Net.NetworkCredential]::new('', $secure).Password
$env:HA_URL = (Get-Content $urlFile -Raw).Trim()
$env:OPTIONS_PATH = Join-Path $PSScriptRoot 'options.json'
if (-not $env:PORT) { $env:PORT = '8100' }

Write-Host "House View local: $env:HA_URL -> http://localhost:$env:PORT  (Ctrl + C to stop)"
node (Join-Path $PSScriptRoot 'house-view\server.js')
