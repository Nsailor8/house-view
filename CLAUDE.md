# House View — rules for Claude Code

House View is a read-only dashboard add-on for a Home Assistant OS mini PC.
The add-on lives in `house-view/` (config.yaml, Dockerfile, server.js, public/).

## Hard rules
- **Read-only.** House View must never control anything in HA. No service calls
  except read-only ones (e.g. `weather.get_forecasts`), no POST/PUT/DELETE routes,
  no new HA permissions in `config.yaml`.
- **Every code change bumps `version`** in `house-view/config.yaml`.
- **No secrets or IP addresses** in any committed file, commit message, or log
  output you save. Use placeholders like `<HAOS IP>`.
- The HA token is only ever read from the `HA_TOKEN` environment variable
  (set by `dev.ps1`). Never write it to a file, never echo it, never read
  `%USERPROFILE%\.house-view\`.
- `options.json` holds real entity IDs and is git-ignored. Don't commit it.

## Branches
- `main` = what is currently running on HAOS. Only merge to `main` after Nick
  confirms the version is deployed.
- `dev` (or feature branches off it) = work in progress.

## Local dev
The backend switches to local mode when `SUPERVISOR_TOKEN` is not set.
Requires Node 22+ (built-in WebSocket and fetch). No npm dependencies — don't add
any without asking.

**One-time setup** (Windows PowerShell, outside the repo). Copy the HA long-lived
token with HA's copy button, then:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.house-view" | Out-Null
(Get-Clipboard -Raw).Trim() | ConvertTo-SecureString -AsPlainText -Force |
  ConvertFrom-SecureString | Set-Content "$env:USERPROFILE\.house-view\token"
Set-Clipboard -Value " "
Set-Content "$env:USERPROFILE\.house-view\ha_url" "http://<HAOS IP>:8123"
```

The token file is encrypted with Windows DPAPI (only this Windows user can read it).
To switch between home and ZeroTier, edit `ha_url`. To replace the token, rerun
the token line.

**Every time**, from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\dev.ps1
```

Then open http://localhost:8100. Edits to `public/` show on Ctrl + F5; edits to
`server.js` need Ctrl + C and rerun.

## Deploying (manual while the repo is private)
1. Copy `house-view/` into `/addons/house-view-dev/` on HAOS (Studio Code Server
   or the `addons` Samba share).
2. Settings → Apps → App store → ⋮ → Check for updates → Update on House View.
3. Hard-refresh the page (Ctrl + F5).
4. Once confirmed running: merge `dev` into `main` and tag `v<version>`.
