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
| `climate` | A name plus a `climate.*` entity per A/C or thermostat | Current temperature, mode and set point (read-only) |
| `co2` / `pm25` on a section | The air monitor's CO₂ and PM2.5 entity IDs | Coloured air-quality readings on that room, plus a CO₂ history tab |
| `network` | A name plus an entity per Deco or device (`device_tracker.*`, `binary_sensor.*`) | An Online/Offline list |

Chart.js is bundled in `public/`, so the page still works when the internet is down.

## Pages and history (v1.3)

- Sidebar pages: Overview, Rooms, Tanks, Weather & A/C, Network and Data. Weather & A/C and Network only appear once configured. On phones the sidebar becomes a bottom tab bar.
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

If a sensor sent nothing during a step, its last value carries over. Times are local, in Home Assistant's time zone. The URL is `/api/export.csv?range=24h|7d|30d|all&kind=temps|humidity|co2|tanks`, so it also works in Excel's Data › Get Data › From Web.

v1.4 also fixes the 7-day chart: HA's history API returns only one day unless `end_time` is passed.
