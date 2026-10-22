'use strict';
/*
 * House View backend.
 * - Connects to Home Assistant's WebSocket API and keeps the latest state of
 *   ONLY the entities listed in the add-on options.
 * - Pushes changes to browsers over Server-Sent Events (/api/stream).
 * - Proxies a whitelisted, read-only slice of HA history (/api/history).
 * - Exports what the chart shows as CSV (/api/export.csv).
 * - Serves the static page in ./public.
 * The browser never sees an HA token and cannot change anything in HA.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8099;
const OPTIONS_PATH = process.env.OPTIONS_PATH || '/data/options.json';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Inside HAOS the Supervisor provides a token and a proxy. For local development,
// set HA_URL and HA_TOKEN (a long-lived token from your HA profile > Security).
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_TOKEN = SUPERVISOR_TOKEN || process.env.HA_TOKEN;
const HA_HTTP = SUPERVISOR_TOKEN
  ? 'http://supervisor/core'
  : (process.env.HA_URL || 'http://homeassistant.local:8123').replace(/\/$/, '');
const HA_WS = SUPERVISOR_TOKEN
  ? 'ws://supervisor/core/websocket'
  : HA_HTTP.replace(/^http/, 'ws') + '/api/websocket';

if (!HA_TOKEN) {
  console.error('No token. Run as an HA add-on, or set HA_URL and HA_TOKEN for local dev.');
  process.exit(1);
}

// ---------- Options ----------
const options = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8'));
const sections = options.sections || [];
const tanks = options.tanks || [];
const climate = options.climate || [];
const network = options.network || [];
const floors = options.floors || [];
const weatherEntity = (options.weather || '').trim();

const watched = new Set();
for (const s of sections) {
  for (const key of ['temperature', 'humidity', 'co2', 'pm25']) {
    if (s[key]) watched.add(s[key]);
  }
}
for (const list of [tanks, climate, network]) {
  for (const x of list) if (x.entity) watched.add(x.entity);
}
if (weatherEntity) watched.add(weatherEntity);

const publicConfig = {
  title: options.title || 'Our House',
  hot_threshold: options.hot_threshold ?? 80,
  tank_alert_threshold: options.tank_alert_threshold ?? 70,
  rain_alert_chance: options.rain_alert_chance ?? 70,
  weather: weatherEntity || null,
  // NWS radar site ID, e.g. KCLX. Only 4 letters are accepted.
  radar_station: /^[A-Z]{4}$/.test((options.radar_station || '').trim().toUpperCase())
    ? options.radar_station.trim().toUpperCase() : null,
  floors,
  sections,
  tanks,
  climate,
  network,
};

// ---------- Chartable sensors (the only ones history/export ever query) ----------
const chartIds = new Set();
for (const s of sections) for (const k of ['temperature', 'humidity', 'co2', 'pm25']) if (s[k]) chartIds.add(s[k]);
for (const t of tanks) if (t.entity) chartIds.add(t.entity);

// ---------- State + browser clients ----------
const states = {};
const clients = new Set();
let haConnected = false;
let forecast = null; // [{ datetime, condition, temperature, templow, precipitation_probability }]

// Only these attributes ever leave the server (A/C and weather cards need them).
const KEEP_ATTRS = ['current_temperature', 'temperature', 'target_temp_high',
  'target_temp_low', 'hvac_action', 'humidity', 'temperature_unit'];

function slim(s) {
  const a = s.attributes || {};
  const attrs = {};
  for (const k of KEEP_ATTRS) if (a[k] !== undefined) attrs[k] = a[k];
  return {
    state: s.state,
    unit: a.unit_of_measurement || '',
    last_changed: s.last_changed,
    attrs,
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) sse(res, event, data);
}

// Keep proxies (e.g. Cloudflare) from closing idle streams.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000);

// ---------- Local time (exports use Home Assistant's time zone) ----------
let timeZone = process.env.TZ || 'UTC';
let tzFormat = null;
const tzOffsets = new Map(); // 15-minute bucket -> offset ms

function setTimeZone(tz) {
  try {
    tzFormat = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    timeZone = tz;
    tzOffsets.clear();
  } catch {
    console.warn(`Unknown time zone ${tz}, keeping ${timeZone}`);
  }
}
setTimeZone(timeZone);

// DST changes happen on 15-minute boundaries, so one lookup per 15 minutes is exact.
function localMs(t) {
  const key = Math.floor(t / 900e3);
  let off = tzOffsets.get(key);
  if (off === undefined) {
    const at = key * 900e3;
    const p = {};
    for (const { type, value } of tzFormat.formatToParts(new Date(at))) p[type] = Number(value);
    off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
    if (tzOffsets.size > 50000) tzOffsets.clear();
    tzOffsets.set(key, off);
  }
  return t + off;
}

function localText(t) {
  return new Date(localMs(t)).toISOString().slice(0, 19).replace('T', ' ');
}

// ---------- Home Assistant WebSocket ----------
let msgId = 0;
let getStatesId = null;
let retryMs = 2000;
let haSocket = null;
const pending = new Map(); // id -> resolve, for one-off requests

function request(payload) {
  return new Promise((resolve, reject) => {
    if (!haSocket || !haConnected) return reject(new Error('Not connected'));
    const id = ++msgId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out')); }, 30000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    haSocket.send(JSON.stringify({ id, ...payload }));
  });
}

// weather.get_forecasts only reads data; it never changes anything in HA.
async function refreshForecast() {
  if (!weatherEntity || !haConnected) return;
  try {
    const msg = await request({
      type: 'call_service',
      domain: 'weather',
      service: 'get_forecasts',
      target: { entity_id: weatherEntity },
      service_data: { type: 'daily' },
      return_response: true,
    });
    if (!msg.success) throw new Error(msg.error ? msg.error.message : 'failed');
    const list = (msg.result.response[weatherEntity] || {}).forecast || [];
    forecast = list.slice(0, 5).map((f) => ({
      datetime: f.datetime,
      condition: f.condition,
      temperature: f.temperature,
      templow: f.templow,
      precipitation_probability: f.precipitation_probability,
    }));
    broadcast('forecast', forecast);
  } catch (e) {
    console.warn(`Could not get forecast for ${weatherEntity}: ${e.message}`);
  }
}
setInterval(refreshForecast, 30 * 60e3);

function connectHA() {
  const ws = new WebSocket(HA_WS);
  haSocket = ws;

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'result' && pending.has(msg.id)) {
      const done = pending.get(msg.id);
      pending.delete(msg.id);
      return done(msg);
    }

    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
    } else if (msg.type === 'auth_invalid') {
      console.error('Home Assistant rejected the token:', msg.message);
    } else if (msg.type === 'auth_ok') {
      console.log('Connected to Home Assistant');
      retryMs = 2000;
      haConnected = true;
      broadcast('status', { connected: true });
      getStatesId = ++msgId;
      ws.send(JSON.stringify({ id: getStatesId, type: 'get_states' }));
      ws.send(JSON.stringify({ id: ++msgId, type: 'subscribe_events', event_type: 'state_changed' }));
      request({ type: 'get_config' })
        .then((m) => { if (m.success && m.result && m.result.time_zone) setTimeZone(m.result.time_zone); })
        .catch(() => {});
    } else if (msg.type === 'result' && msg.id === getStatesId && msg.success) {
      for (const s of msg.result) {
        if (watched.has(s.entity_id)) states[s.entity_id] = slim(s);
      }
      for (const id of watched) {
        if (!states[id]) console.warn(`Not found in Home Assistant (check the name): ${id}`);
      }
      broadcast('snapshot', states);
      refreshForecast();
    } else if (msg.type === 'event') {
      const d = msg.event && msg.event.data;
      if (d && d.new_state && watched.has(d.entity_id)) {
        states[d.entity_id] = slim(d.new_state);
        broadcast('state', { entity_id: d.entity_id, ...states[d.entity_id] });
      }
    }
  });

  ws.addEventListener('error', (e) => {
    console.error('Home Assistant connection error', e && e.message ? e.message : '');
  });

  ws.addEventListener('close', () => {
    if (haConnected) console.warn('Lost connection to Home Assistant, retrying');
    haConnected = false;
    for (const done of pending.values()) done({ success: false, error: { message: 'connection lost' } });
    pending.clear();
    broadcast('status', { connected: false });
    setTimeout(connectHA, retryMs);
    retryMs = Math.min(retryMs * 2, 60000);
  });
}

// ---------- History (read-only, whitelisted, cached) ----------
// 24h and 7d use HA's detailed history (kept ~10 days by default).
// 30d and "all" use HA's long-term statistics, which HA keeps forever.
const RANGES = {
  '24h': { hours: 24, source: 'history', ttl: 60e3 },
  '7d': { hours: 168, source: 'history', ttl: 5 * 60e3 },
  '30d': { hours: 720, source: 'stats', period: 'hour', ttl: 15 * 60e3 },
  all: { hours: null, source: 'stats', period: 'day', ttl: 60 * 60e3 },
};
const MAX_POINTS = 400; // per chart line, keeps the chart fast and the lines clean

// Average points into evenly spaced time buckets.
function downsample(points, start, end) {
  if (points.length <= MAX_POINTS) return points;
  const width = (end - start) / MAX_POINTS;
  const buckets = new Map();
  for (const [t, v] of points) {
    const b = Math.min(MAX_POINTS - 1, Math.floor((t - start) / width));
    const cur = buckets.get(b) || { tSum: 0, vSum: 0, n: 0 };
    cur.tSum += t; cur.vSum += v; cur.n += 1;
    buckets.set(b, cur);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((b) => {
    const c = buckets.get(b);
    return [Math.round(c.tSum / c.n), Math.round((c.vSum / c.n) * 100) / 100];
  });
}

// Every recorded state change, as [time, value].
async function rawHistory(hours) {
  const end = Date.now();
  const start = end - hours * 3600e3;
  const ids = [...chartIds].map(encodeURIComponent).join(',');
  // end_time is required: without it HA returns only one day from the start.
  const url = `${HA_HTTP}/api/history/period/${encodeURIComponent(new Date(start).toISOString())}` +
    `?end_time=${encodeURIComponent(new Date(end).toISOString())}` +
    `&filter_entity_id=${ids}&minimal_response&no_attributes`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${HA_TOKEN}` } });
  if (!r.ok) throw new Error(`HA history returned ${r.status}`);
  const raw = await r.json();

  const series = {};
  for (const list of raw) {
    if (!list.length) continue;
    const id = list[0].entity_id; // minimal_response only tags the first point
    if (!chartIds.has(id)) continue;
    const pts = list
      .map((p) => [Math.max(start, Date.parse(p.last_changed)), Number(p.state)])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length) series[id] = pts;
  }
  return { start, end, source: 'history', series };
}

// Long-term statistics, as [time, mean, min, max].
async function rawStatistics(hours, period) {
  const end = Date.now();
  const startReq = hours ? end - hours * 3600e3 : Date.UTC(2015, 0, 1);
  const msg = await request({
    type: 'recorder/statistics_during_period',
    start_time: new Date(startReq).toISOString(),
    end_time: new Date(end).toISOString(),
    statistic_ids: [...chartIds],
    period,
    types: ['mean', 'min', 'max', 'state'],
    units: { temperature: '°F' },
  });
  if (!msg.success) throw new Error(msg.error ? msg.error.message : 'statistics failed');

  const r2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
  const series = {};
  let earliest = end;
  for (const [id, rows] of Object.entries(msg.result || {})) {
    if (!chartIds.has(id)) continue;
    const pts = rows
      .map((r) => {
        const t = typeof r.start === 'number' ? r.start : Date.parse(r.start);
        return [t, r2(r.mean ?? r.state), r2(r.min), r2(r.max)];
      })
      .filter((p) => Number.isFinite(p[0]) && p[1] !== null);
    if (!pts.length) continue;
    earliest = Math.min(earliest, pts[0][0]);
    series[id] = pts;
  }
  // For "all time", start where the data starts.
  const start = hours ? startReq : earliest;
  return { start, end, source: 'stats', period, series };
}

// Cached and de-duplicated, so the chart and an Excel refresh share one HA query.
const rawCache = new Map(); // key -> { at, data }
const rawInFlight = new Map(); // key -> Promise

async function getRaw(range, period) {
  const cfg = RANGES[range];
  const key = `${range}:${period || ''}`;
  const cached = rawCache.get(key);
  if (cached && Date.now() - cached.at < cfg.ttl) return cached.data;
  if (rawInFlight.has(key)) return rawInFlight.get(key);
  const p = (cfg.source === 'history' ? rawHistory(cfg.hours) : rawStatistics(cfg.hours, period))
    .then((data) => { rawCache.set(key, { at: Date.now(), data }); return data; })
    .finally(() => rawInFlight.delete(key));
  rawInFlight.set(key, p);
  return p;
}

async function getHistory(range) {
  const cfg = RANGES[range];
  const raw = await getRaw(range, cfg.period);
  const series = {};
  for (const [id, pts] of Object.entries(raw.series)) {
    const line = pts.map(([t, v]) => [t, v]);
    // Sensor values hold until they change, so carry the last one to "now".
    if (raw.source === 'history') line.push([raw.end, line[line.length - 1][1]]);
    series[id] = downsample(line, Math.min(raw.start, line[0][0]), raw.end);
  }
  return { start: raw.start, end: raw.end, series, range, source: raw.source };
}

// ---------- Export: the chart's data as CSV ----------
// Same tab, range and resolution as the chart, one column per line, one row per time step.
// 24h: 5-minute averages. 7d: 30-minute averages. 30d: hourly. All time: daily.
const EXPORT_STEP = { '24h': 5 * 60e3, '7d': 30 * 60e3 };
const KIND_FILE = { temps: 'temperature', humidity: 'humidity', co2: 'co2', tanks: 'tanks' };

// combine: temperature and humidity side by side for each section (temps/humidity tabs only),
// with the current tab's value first: "Section 1 Temperature (°F)", "Section 1 Humidity (%)", …
function exportColumns(kind, combine) {
  const bySection = [...sections].sort((a, b) => a.number - b.number);
  const TEMP = { key: 'temperature', name: 'Temperature', unit: '°F' };
  const HUM = { key: 'humidity', name: 'Humidity', unit: '%' };
  if ((kind === 'temps' || kind === 'humidity') && combine) {
    const order = kind === 'temps' ? [TEMP, HUM] : [HUM, TEMP];
    return bySection.flatMap((s) => order.filter((m) => s[m.key])
      .map((m) => ({ header: `Section ${s.number} ${m.name} (${m.unit})`, id: s[m.key] })));
  }
  if (kind === 'temps') return bySection.filter((s) => s.temperature).map((s) => ({ header: `Section ${s.number} (°F)`, id: s.temperature }));
  if (kind === 'humidity') return bySection.filter((s) => s.humidity).map((s) => ({ header: `Section ${s.number} (%)`, id: s.humidity }));
  if (kind === 'co2') return bySection.filter((s) => s.co2).map((s) => ({ header: `Section ${s.number} (ppm)`, id: s.co2 }));
  return tanks.filter((t) => t.entity).map((t) => ({ header: `${t.name} (%)`, id: t.entity }));
}

function round2(v) { return Math.round(v * 100) / 100; }

function chartTable(raw, kind, range, combine) {
  const cols = exportColumns(kind, combine);
  const headers = ['Time', ...cols.map((c) => c.header)];
  const rows = [];

  if (raw.source === 'stats') {
    // Statistics rows already line up on the hour (30d) or day (all time).
    const byTime = new Map();
    cols.forEach((c, i) => {
      for (const [t, v] of raw.series[c.id] || []) {
        if (!byTime.has(t)) byTime.set(t, new Array(cols.length).fill(null));
        byTime.get(t)[i] = v;
      }
    });
    for (const t of [...byTime.keys()].sort((a, b) => a - b)) rows.push({ t, cells: byTime.get(t) });
    return { headers, rows };
  }

  // Detailed history: average the readings in each step; if a step has none, hold the last value.
  const step = EXPORT_STEP[range];
  const first = Math.floor(raw.start / step) * step;
  const n = Math.ceil((raw.end - first) / step);
  const grid = Array.from({ length: n }, () => new Array(cols.length).fill(null));
  cols.forEach((c, i) => {
    const pts = raw.series[c.id] || [];
    const sum = new Float64Array(n);
    const cnt = new Uint32Array(n);
    for (const [t, v] of pts) {
      const b = Math.min(n - 1, Math.floor((t - first) / step));
      if (b >= 0) { sum[b] += v; cnt[b] += 1; }
    }
    let last = null;
    for (let b = 0; b < n; b++) {
      if (cnt[b]) last = round2(sum[b] / cnt[b]);
      grid[b][i] = last;
    }
  });
  for (let b = 0; b < n; b++) rows.push({ t: first + b * step, cells: grid[b] });
  return { headers, rows };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(table) {
  const out = ['﻿' + table.headers.map(csvCell).join(',')]; // BOM so Excel reads ° and · correctly
  for (const r of table.rows) out.push([localText(r.t), ...r.cells].map(csvCell).join(','));
  return out.join('\r\n') + '\r\n';
}

function csvName(range, kind, combine) {
  const slug = publicConfig.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'house';
  const what = combine ? (kind === 'temps' ? 'temperature-humidity' : 'humidity-temperature') : KIND_FILE[kind];
  return `${slug}-${what}-${range}-${localText(Date.now()).slice(0, 10)}.csv`;
}

// ---------- HTTP server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.ico': 'image/x-icon',
};

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }

  if (url.pathname === '/api/config') return json(res, publicConfig);

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sse(res, 'status', { connected: haConnected });
    sse(res, 'snapshot', states);
    if (forecast) sse(res, 'forecast', forecast);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/history') {
    const range = url.searchParams.get('range') || '24h';
    if (!RANGES[range]) return json(res, { error: 'Unknown range' }, 400);
    try {
      return json(res, await getHistory(range));
    } catch (e) {
      console.error(e.message);
      return json(res, { error: 'History unavailable' }, 502);
    }
  }

  // The chart's data as CSV: ?range=24h|7d|30d|all &kind=temps|humidity|co2|tanks [&combine=1]
  if (url.pathname === '/api/export.csv') {
    const range = url.searchParams.get('range') || '24h';
    const kind = url.searchParams.get('kind') || 'temps';
    if (!RANGES[range]) return json(res, { error: 'Unknown range' }, 400);
    if (!KIND_FILE[kind]) return json(res, { error: 'Unknown kind' }, 400);
    // &combine=1 on the Temperature or Humidity tab adds the other one.
    const combine = url.searchParams.get('combine') === '1' && (kind === 'temps' || kind === 'humidity');
    try {
      const raw = await getRaw(range, RANGES[range].period);
      const body = Buffer.from(toCsv(chartTable(raw, kind, range, combine)), 'utf8');
      const name = csvName(range, kind, combine);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      console.error(`Export failed: ${e.message}`);
      return json(res, { error: 'Export unavailable' }, 502);
    }
  }

  // Static files
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`House View on port ${PORT}, watching ${watched.size} entities`);
  connectHA();
});

process.on('SIGTERM', () => {
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
