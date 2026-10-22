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
- The HA token is only ever read from the `HA_TOKEN` environment variable.
  Never write it to a file, never echo it.
- `options.json` holds real entity IDs and is git-ignored. Don't commit it.

## Branches
- `main` = what is currently running on HAOS. Only merge to `main` after Nick
  confirms the version is deployed.
- `dev` (or feature branches off it) = work in progress.

## Local dev
The backend switches to local mode when `SUPERVISOR_TOKEN` is not set.

```powershell
cd house-view
$env:HA_URL = "http://<HAOS IP>:8123"
$env:HA_TOKEN = Read-Host -MaskInput "HA token"
$env:OPTIONS_PATH = "..\options.json"
$env:PORT = "8100"
node server.js
```

Then open http://localhost:8100. Requires Node 22+ (built-in WebSocket and fetch).
No npm dependencies — don't add any without asking.

## Deploying (manual while the repo is private)
1. Copy `house-view/` into `/addons/house-view/` on HAOS (Studio Code Server).
2. Settings → Apps → App store → ⋮ → Check for updates → Update on House View.
3. Hard-refresh the page (Ctrl + F5).
