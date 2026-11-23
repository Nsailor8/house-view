# House View

A simple, read-only web page for the house. It runs as a local Home Assistant add-on on the mini PC and shows the 9 section temperatures, both tank levels and history charts. The viewer never sees Home Assistant itself and can't change anything.

## Install on HAOS

1. In HA, install the **Samba share** or **Advanced SSH & Web Terminal** add-on so you can reach the `/addons` folder.
2. Copy this whole `house-view` folder to `/addons/house-view/`.
3. Go to **Settings > Add-ons > Add-on Store**, open the ⋮ menu, choose **Check for updates**. "House View" appears under **Local add-ons**.
4. Install it, then open its **Configuration** tab and put in your real entity IDs (see below).
5. Start it. Open `http://<mini-pc-ip>:8099` from any device on your Wi-Fi.

After changing code, bump `version` in `config.yaml` and click **Rebuild** (or Update) on the add-on.

## Finding entity IDs

Settings > Devices & services > Entities. Search "temperature" or "tank" and click a sensor; the gear icon shows its **Entity ID**, for example `sensor.govee_h5075_a1b2_temperature`. Rename it there to something readable like `sensor.section_4_temperature` and the defaults in `config.yaml` will just work.

The add-on log prints `Not found in Home Assistant` for any ID that doesn't match.

## Local development (optional)

```bash
cd house-view
cat > /tmp/options.json <<'EOF'
{ ...copy the options block from config.yaml as JSON... }
EOF
HA_URL=http://homeassistant.local:8123 HA_TOKEN=<long-lived token> \
  OPTIONS_PATH=/tmp/options.json node server.js
```

Create the long-lived token in HA under your profile > Security. Node 22+ is required (built-in WebSocket).

## Files

- `config.yaml` – add-on definition and the default layout/entity list
- `Dockerfile` – Node 22 Alpine, no npm dependencies
- `server.js` – connects to HA, keeps only whitelisted entities, serves the page and the exports
- `public/` – the page (HTML, CSS, JS, and a bundled copy of Chart.js)

## Optional sections (v1.2)

Each of these stays hidden on the page until you fill it in on the Configuration tab.

| Option | What to enter | What appears |
| --- | --- | --- |
| `weather` | Your weather entity, e.g. `weather.forecast_home` | Current weather, a 5-day forecast, and a red "empty the tanks" banner when rain chance in the next 2 days is at least `rain_alert_chance` and a tank is above `tank_alert_threshold` |
| `outdoor_temperature` / `outdoor_humidity` | `sensor.*` entities for the outside temperature (°F) and humidity (%) | A dashed **Outside** line on the Temperature and Humidity charts, and an Outside column in the CSV (v1.6) |
| `climate` | A name plus a `climate.*` entity per A/C or thermostat | Current temperature, mode and set point (read-only) |
| `co2` / `pm25` on a section | The air monitor's CO₂ and PM2.5 entity IDs | Coloured air-quality readings on that room, plus a CO₂ history tab |
| `network` | Topology nodes (see below) | House map of Decos on Network, Deco list with MAC/IP, Internet + Decos online on Overview |

### Network topology (v1.5)

Each entry is a node in the topology. Status is computed **on the server** and pushed over SSE. Entity IDs stay on the server; Deco MAC and IP (from HA attributes) are shown on the Network page only.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable id (used as `parent` by children) |
| `name` | yes | Display name |
| `type` | yes | `router`, `deco`, `switch`, `haos`, or `client` |
| `parent` | no | Parent node `id` (omit for roots) |
| `section` | no | House section number — places a Deco badge on that room |
| `link` | no | `wired` (solid) or `wireless` (dashed) connector from the parent |
| `entity` | no | Read-only HA entity (`device_tracker.*`, etc.) for online/offline |
| `deco_name` | no | Must match clients' `deco_device` attribute (not the entity id — clients keep the Deco they first joined in their entity id when they roam) |
| `planned` | no | Show as planned (dashed badge); excluded from “Decos online” counts |

**Status rules:** an entity node is `on` / `off` / `unknown` from its state. `haos` with no entity follows the add-on's HA connection. `planned` nodes stay `planned`. Other nodes without an entity (switch, router) are `on` if any descendant is `on`, `off` if every non-planned descendant is `off`, else `unknown`. Deco client counts are online `device_tracker` entities whose `deco_device` equals that node's `deco_name`. Internet status comes from the Deco with `master: true` (`internet_online` attribute), read server-side only.

House View is read-only: it never calls ha-tplink-deco control entities or services (`switch.deco_polling`, `select.polling_interval`, `tplink_deco.reboot_deco`, etc.).

Chart.js is bundled in `public/`, so the page still works when the internet is down.

## Pages and history (v1.3)

- Sidebar pages: Overview, Temperature, Tanks, Weather & A/C, Network and Data. Weather & A/C and Network only appear once configured. On phones the sidebar becomes a bottom tab bar.
- `radar_station`: a 4-letter NWS radar site (e.g. `KCLX` for Charleston) adds a radar loop to the Weather & A/C page.
- Data ranges: 24 hours and 7 days use HA's detailed history (kept 10 days by default). 30 days and All time use HA's long-term statistics (hourly/daily averages, kept forever). Sensors need a `state_class` of `measurement` for long-term statistics, which Govee and most level sensors have.

## CSV of the chart (v1.4)

A **Download CSV** button under the chart on the Data page saves exactly what the chart shows: the selected tab (Temperature, Humidity, CO₂ or Tanks) and range, one column per line, labelled with the section number and unit (e.g. `Section 4 (°F)`). Tank columns use the tank names.

| Range | One row per | Source |
| --- | --- | --- |
| 24 hours | 5 minutes (average of the readings in it) | HA detailed history |
| 7 days | 30 minutes (average) | HA detailed history |
| 30 days | hour (average) | HA long-term statistics |
| All time | day (average) | HA long-term statistics |

On the Temperature and Humidity tabs, an **Include humidity** / **Include temperature** checkbox next to the button adds the other reading, side by side per section (`Section 1 Temperature (°F)`, `Section 1 Humidity (%)`, …). It works for every range and adds `&combine=1` to the URL.

If a sensor sent nothing during a step, its last value carries over. Times are local, in Home Assistant's time zone. The URL is `/api/export.csv?range=24h|7d|30d|all&kind=temps|humidity|co2|tanks[&combine=1][&side=0|1|2]`, so it also works in Excel's Data › Get Data › From Web.

v1.4 also fixes the 7-day chart: HA's history API returns only one day unless `end_time` is passed.

## Sides and the outside line (v1.6)

**Sides.** `columns` names the three columns of the house diagram, left to right (column 0, 1, 2). The defaults are `David's side` (sections 7–9), `Tiny home` (4–6) and `JP's side` (1–3). On the Data page a third row of buttons appears on the Temperature, Humidity and CO₂ tabs:

- **All**: one chart with every section (as before).
- **A side's name**: one chart with only that side's sections. Download CSV then has only those sections (`&side=0|1|2`) and the side's name in the file name.
- **Each side**: one chart per side, stacked, on the same scale so the sides can be compared. Download CSV has every section.

A section keeps the same colour in every view. Clicking a name in a chart's legend hides that line, and it stays hidden across the views and the 5-minute refresh until it's clicked again or the page is reloaded. Set a column's name to `""` to leave it out of the filter; with fewer than two named columns the row is hidden.

**Outside.** `outdoor_temperature` and `outdoor_humidity` add a dashed, neutral **Outside** line to the Temperature and Humidity charts in every view, and an `Outside (°F)` / `Outside (%)` column at the end of the CSV. They must be `sensor.*` entities, because the charts read HA's history and long-term statistics of an entity's state; a `weather.*` entity keeps its temperature in an attribute, which has neither. Use a real outdoor sensor, or a template sensor that copies the weather entity's `temperature` / `humidity` attribute (state class `measurement`, so the 30-day and All-time ranges work). The line starts when the sensor starts recording; until then the chart says "No outside readings for this period yet."
