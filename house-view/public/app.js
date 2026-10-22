'use strict';
/* House View frontend: reads only from this add-on's own /api endpoints. */

let config = null;
const states = {};
let chart = null;
let chartKind = 'temps';
const STALE_MS = 2 * 3600e3; // grey out a room if a sensor hasn't reported in 2 h

const $ = (id) => document.getElementById(id);

function num(entityId) {
  const s = states[entityId];
  if (!s) return null;
  const n = Number(s.state);
  return Number.isFinite(n) ? n : null;
}

function tempClass(t) {
  if (t === null) return '';
  const hot = config.hot_threshold;
  if (t >= hot) return 't-hot';
  if (t >= hot - 4) return 't-warm';
  if (t < 64) return 't-cold';
  return 't-ok';
}

// ---------- Build layout once from config ----------
function buildHouse() {
  const wrap = $('floors');
  wrap.innerHTML = '';
  config.floors.forEach((floorName, fi) => {
    const floor = document.createElement('div');
    floor.className = 'floor';
    floor.innerHTML = `<div class="floor-label">${floorName}</div><div class="rooms"></div>`;
    const rooms = floor.querySelector('.rooms');
    for (let col = 0; col < 3; col++) {
      const s = config.sections.find((x) => x.floor === fi && x.column === col);
      const room = document.createElement('div');
      room.className = 'room';
      if (s) {
        room.id = `room-${s.number}`;
        room.innerHTML = `<div class="name">${s.name}</div><div class="temp">–</div>` +
          `<div class="hum"></div><div class="air"></div>`;
      } else {
        room.style.visibility = 'hidden';
      }
      rooms.appendChild(room);
    }
    wrap.appendChild(floor);
  });
}

function buildTanks() {
  $('tanks').innerHTML = config.tanks.map((t, i) => `
    <div class="tank" id="tank-${i}">
      <div class="tank-body"><div class="tank-fill"></div><div class="tank-pct">–</div></div>
      <div class="tank-name">${t.name}</div>
      <div class="tank-note"></div>
    </div>`).join('');
}

function buildOptional() {
  $('climate-card').hidden = !config.climate.length;
  $('climate').innerHTML = config.climate.map((c, i) => `
    <div class="ac" id="ac-${i}">
      <div class="name">${c.name}</div><div class="now">–</div><div class="mode"></div>
    </div>`).join('');

  $('network').innerHTML = config.network.map((n, i) => `
    <div class="net" id="net-${i}"><span>${n.name}</span><span class="s">–</span></div>`).join('');

  const hasAir = config.sections.some((s) => s.co2 || s.pm25);
  $('air-legend').hidden = !hasAir;
  document.querySelector('[data-kind="co2"]').hidden = !config.sections.some((s) => s.co2);

  $('weather-card').hidden = !config.weather;
  $('radar-card').hidden = !config.radar_station;
  if (config.radar_station) refreshRadar();

  const hasWeatherPage = !!(config.weather || config.radar_station || config.climate.length);
  navLink('weather').hidden = !hasWeatherPage;
  navLink('network').hidden = !config.network.length;
  $('sum-weather-card').hidden = !config.weather;
  $('sum-ac-card').hidden = !config.climate.length;
  $('sum-net-card').hidden = !config.network.length;
}

function refreshRadar() {
  // NWS RIDGE standard loop for the configured radar site.
  $('radar').src = `https://radar.weather.gov/ridge/standard/${config.radar_station}_loop.gif?t=${Date.now()}`;
}

// ---------- Air quality ----------
// CO₂ (ppm): under 800 good, under 1200 fair. PM2.5 (µg/m³): under 12 good, under 35 fair.
function aqLevel(value, fair, poor) {
  if (value === null) return null;
  return value < fair ? 'good' : value < poor ? 'fair' : 'poor';
}

function airHtml(s) {
  const parts = [];
  const co2 = s.co2 ? num(s.co2) : null;
  const pm = s.pm25 ? num(s.pm25) : null;
  if (co2 !== null) parts.push(`<span><b class="aq ${aqLevel(co2, 800, 1200)}"></b>CO₂ ${Math.round(co2)}</span>`);
  if (pm !== null) parts.push(`<span><b class="aq ${aqLevel(pm, 12, 35)}"></b>PM2.5 ${Math.round(pm)}</span>`);
  return parts.join('');
}

// ---------- A/C ----------
const HVAC_ACTION = { cooling: 'Cooling', heating: 'Heating', idle: 'Idle', off: 'Off',
  drying: 'Drying', fan: 'Fan only' };
const HVAC_MODE = { cool: 'Cool', heat: 'Heat', heat_cool: 'Auto', auto: 'Auto', off: 'Off',
  dry: 'Dry', fan_only: 'Fan only' };

function renderClimate() {
  config.climate.forEach((c, i) => {
    const el = $(`ac-${i}`);
    const s = states[c.entity];
    if (!el) return;
    if (!s || s.state === 'unavailable' || s.state === 'unknown') {
      el.className = 'ac';
      el.querySelector('.now').textContent = '–';
      el.querySelector('.mode').textContent = 'Not responding';
      return;
    }
    const a = s.attrs || {};
    const now = a.current_temperature;
    const target = a.temperature ?? a.target_temp_high;
    el.querySelector('.now').textContent = now == null ? '–' : `${Math.round(now)}°`;
    const action = HVAC_ACTION[a.hvac_action] || HVAC_MODE[s.state] || s.state;
    el.querySelector('.mode').textContent =
      s.state === 'off' ? 'Off' : `${action}${target != null ? ` · set to ${Math.round(target)}°` : ''}`;
    el.className = `ac ${a.hvac_action === 'cooling' ? 'cooling' : ''}`;
  });
}

// ---------- Network ----------
const ONLINE = new Set(['home', 'on', 'connected', 'online', 'true']);
const OFFLINE = new Set(['not_home', 'off', 'disconnected', 'offline', 'false', 'unavailable']);

function renderNetwork() {
  config.network.forEach((n, i) => {
    const el = $(`net-${i}`);
    const s = states[n.entity];
    if (!el) return;
    const label = el.querySelector('.s');
    const st = s ? String(s.state).toLowerCase() : null;
    if (st && ONLINE.has(st)) { label.textContent = 'Online'; label.className = 's on'; }
    else if (st && OFFLINE.has(st)) { label.textContent = 'Offline'; label.className = 's off'; }
    else { label.textContent = s ? s.state : '–'; label.className = 's'; }
  });
}

// ---------- Weather + storm prep ----------
let forecast = null;
const ICON = { 'clear-night': '🌙', cloudy: '☁️', exceptional: '⚠️', fog: '🌫️', hail: '🌨️',
  lightning: '🌩️', 'lightning-rainy': '⛈️', partlycloudy: '⛅', pouring: '🌧️', rainy: '🌦️',
  snowy: '❄️', 'snowy-rainy': '🌨️', sunny: '☀️', windy: '💨', 'windy-variant': '💨' };
const CONDITION = { 'clear-night': 'Clear', cloudy: 'Cloudy', fog: 'Foggy', hail: 'Hail',
  lightning: 'Thunderstorms', 'lightning-rainy': 'Thunderstorms', partlycloudy: 'Partly cloudy',
  pouring: 'Heavy rain', rainy: 'Rain', snowy: 'Snow', 'snowy-rainy': 'Sleet', sunny: 'Sunny',
  windy: 'Windy', 'windy-variant': 'Windy' };

function renderWeather() {
  if (!config.weather) return;
  const w = states[config.weather];
  if (w) {
    const t = w.attrs && w.attrs.temperature;
    $('weather-now').innerHTML =
      `<span class="big">${t == null ? '–' : Math.round(t) + '°'}</span>` +
      `<span>${ICON[w.state] || ''} ${CONDITION[w.state] || w.state}</span>`;
  }
  if (forecast) {
    $('forecast').innerHTML = forecast.map((f, i) => {
      const d = new Date(f.datetime);
      const day = i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short' });
      const rain = f.precipitation_probability;
      const wet = rain != null && rain >= config.rain_alert_chance;
      return `<div class="day ${wet ? 'wet' : ''}">
        <div class="d">${day}</div>
        <div class="i">${ICON[f.condition] || '·'}</div>
        <div class="t">${f.temperature == null ? '' : Math.round(f.temperature) + '°'}` +
        `${f.templow == null ? '' : ' / ' + Math.round(f.templow) + '°'}</div>
        <div class="r">${rain == null ? '' : rain + '% rain'}</div>
      </div>`;
    }).join('');
  }
}

// Same rule as JP's phone alert: rain likely in the next 2 days and a tank above the threshold.
function renderAlert() {
  const box = $('alert');
  if (!forecast) { box.hidden = true; return; }
  const chances = forecast.slice(0, 2).map((f) => f.precipitation_probability).filter((x) => x != null);
  const rain = chances.length ? Math.max(...chances) : 0;
  const full = config.tanks
    .map((t) => ({ name: t.name, v: num(t.entity) }))
    .filter((t) => t.v !== null && t.v >= config.tank_alert_threshold);
  if (rain < config.rain_alert_chance || !full.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `🌧️ Rain likely in the next 2 days (${rain}% chance). Time to empty the tanks.` +
    `<small>${full.map((t) => `${t.name}: ${Math.round(t.v)}% full`).join(' · ')}</small>`;
}

// ---------- Render live values ----------
function renderOverview() {
  // Inside: average per floor plus the warmest room
  const rows = config.floors.map((name, fi) => {
    const temps = config.sections.filter((x) => x.floor === fi).map((x) => num(x.temperature))
      .filter((t) => t !== null);
    const avg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    const hot = avg !== null && avg >= config.hot_threshold;
    return `<div class="sum-row"><span>${name}</span>` +
      `<span class="v ${hot ? 'hot' : ''}">${avg === null ? '–' : Math.round(avg) + '°'}</span></div>`;
  });
  const warm = config.sections.map((x) => ({ n: x.name, t: num(x.temperature) }))
    .filter((x) => x.t !== null).sort((a, b) => b.t - a.t)[0];
  if (warm) rows.push(`<div class="sum-row muted"><span>Warmest: ${warm.n}</span><span>${Math.round(warm.t)}°</span></div>`);
  $('sum-floors').innerHTML = rows.join('');

  $('sum-tanks').innerHTML = config.tanks.map((t) => {
    const v = num(t.entity);
    const full = v !== null && v >= config.tank_alert_threshold;
    return `<div><div class="sum-row"><span>${t.name}</span>` +
      `<span class="v ${full ? 'hot' : ''}">${v === null ? '–' : Math.round(v) + '%'}</span></div>` +
      `<div class="mini-bar"><i class="${full ? 'full' : ''}" style="width:${v === null ? 0 : Math.max(0, Math.min(100, v))}%"></i></div></div>`;
  }).join('');

  if (config.weather) {
    const w = states[config.weather];
    const today = forecast && forecast[0];
    $('sum-weather').innerHTML = !w ? '<div class="muted">No reading</div>' :
      `<div class="sum-row"><span>${ICON[w.state] || ''} ${CONDITION[w.state] || w.state}</span>` +
      `<span class="v">${w.attrs && w.attrs.temperature != null ? Math.round(w.attrs.temperature) + '°' : '–'}</span></div>` +
      (today && today.precipitation_probability != null
        ? `<div class="sum-row muted"><span>Rain today</span><span>${today.precipitation_probability}%</span></div>` : '');
  }

  if (config.climate.length) {
    $('sum-ac').innerHTML = config.climate.map((c) => {
      const st = states[c.entity];
      const a = (st && st.attrs) || {};
      const label = !st || st.state === 'unavailable' ? 'Not responding'
        : st.state === 'off' ? 'Off' : (HVAC_ACTION[a.hvac_action] || HVAC_MODE[st.state] || st.state);
      return `<div class="sum-row"><span>${c.name}</span><span class="v">${label}</span></div>`;
    }).join('');
  }

  if (config.network.length) {
    let on = 0;
    for (const n of config.network) {
      const st = states[n.entity];
      if (st && ONLINE.has(String(st.state).toLowerCase())) on += 1;
    }
    const all = on === config.network.length;
    $('sum-net').innerHTML = `<div class="sum-row"><span>Devices online</span>` +
      `<span class="v ${all ? 'good' : 'hot'}">${on} of ${config.network.length}</span></div>`;
  }
}

function render() {
  renderOverview();
  renderClimate();
  renderNetwork();
  renderWeather();
  renderAlert();
  for (const s of config.sections) {
    const el = $(`room-${s.number}`);
    if (!el) continue;
    const t = num(s.temperature);
    const h = s.humidity ? num(s.humidity) : null;
    const st = states[s.temperature];
    el.className = `room ${tempClass(t)}`;
    if (st && Date.now() - new Date(st.last_changed) > STALE_MS) el.classList.add('stale');
    el.querySelector('.temp').textContent = t === null ? '–' : `${Math.round(t)}°`;
    el.querySelector('.hum').textContent = h === null ? '' : `${Math.round(h)}% humidity`;
    el.querySelector('.air').innerHTML = airHtml(s);
  }

  config.tanks.forEach((t, i) => {
    const el = $(`tank-${i}`);
    const v = num(t.entity);
    const pct = v === null ? null : Math.max(0, Math.min(100, v));
    el.querySelector('.tank-fill').style.height = pct === null ? '0' : `${pct}%`;
    el.querySelector('.tank-pct').innerHTML = `<span>${pct === null ? '–' : Math.round(pct) + '%'}</span>`;
    const alert = pct !== null && pct >= config.tank_alert_threshold;
    el.classList.toggle('alert', alert);
    el.querySelector('.tank-note').textContent =
      pct === null ? 'No reading' : alert ? 'Getting full' : 'OK';
  });
}

// ---------- Live updates ----------
function setStatus(connected) {
  $('dot').className = `dot ${connected ? 'on' : 'off'}`;
  $('dot2').className = `dot ${connected ? 'on' : 'off'}`;
  $('status-text').textContent = connected ? 'Live' : 'Reconnecting…';
}

function connectStream() {
  const es = new EventSource('api/stream');
  es.addEventListener('status', (e) => setStatus(JSON.parse(e.data).connected));
  es.addEventListener('snapshot', (e) => { Object.assign(states, JSON.parse(e.data)); render(); });
  es.addEventListener('state', (e) => {
    const d = JSON.parse(e.data);
    states[d.entity_id] = d;
    render();
  });
  es.addEventListener('forecast', (e) => { forecast = JSON.parse(e.data); render(); });
  es.onerror = () => setStatus(false); // EventSource reconnects automatically
}

// ---------- History chart ----------
const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
                 '#0891b2', '#db2777', '#65a30d', '#475569'];
let chartRange = '24h';
const DAY = 864e5;

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

// Tick marks on local-time boundaries (midnights, month starts) instead of arbitrary numbers.
function makeTicks(min, max) {
  const span = max - min;
  const ticks = [];
  if (span <= 1.5 * DAY) {
    const d = new Date(min); d.setMinutes(0, 0, 0);
    d.setHours(Math.ceil(d.getHours() / 3) * 3);
    for (let t = d.getTime(); t <= max; t += 3 * 3600e3) ticks.push(t);
  } else if (span <= 45 * DAY) {
    const step = span <= 10 * DAY ? 1 : span <= 20 * DAY ? 2 : 5;
    for (let t = startOfDay(min) + DAY; t <= max; ) {
      ticks.push(t);
      const d = new Date(t); d.setDate(d.getDate() + step); t = d.getTime();
    }
  } else {
    const d = new Date(min); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
    const months = Math.ceil(span / (30 * DAY));
    const step = months <= 8 ? 1 : months <= 24 ? 3 : 6;
    for (; d.getTime() <= max; d.setMonth(d.getMonth() + step)) ticks.push(d.getTime());
  }
  return ticks;
}

function tickLabel(t, span) {
  const d = new Date(t);
  if (span <= 1.5 * DAY) {
    return d.getHours() === 0
      ? d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' })
      : d.toLocaleTimeString([], { hour: 'numeric' });
  }
  if (span <= 10 * DAY) return d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
  if (span <= 45 * DAY) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', year: 'numeric' });
}

function seriesFor(kind) {
  const label = (s) => `${s.number} · ${s.name}`;
  if (kind === 'temps') return config.sections.map((s) => ({ label: label(s), id: s.temperature }));
  if (kind === 'humidity') return config.sections.filter((s) => s.humidity).map((s) => ({ label: label(s), id: s.humidity }));
  if (kind === 'co2') return config.sections.filter((s) => s.co2).map((s) => ({ label: label(s), id: s.co2 }));
  return config.tanks.map((t) => ({ label: t.name, id: t.entity }));
}

async function loadChart() {
  if (currentPage !== 'data') return; // only draw while the Data page is showing
  const range = chartRange;
  $('chart-msg').textContent = 'Loading…';
  let data;
  try {
    const r = await fetch(`api/history?range=${range}`);
    data = await r.json();
    if (data.error) throw new Error(data.error);
  } catch {
    $('chart-msg').textContent = 'History is unavailable right now.';
    return;
  }
  if (range !== chartRange) return; // user switched while loading

  const series = seriesFor(chartKind);
  const axisTitle = { temps: '°F', humidity: '% humidity', co2: 'CO₂ (ppm)', tanks: '% full' }[chartKind];
  const datasets = series.map((s, i) => ({
    label: s.label,
    data: (data.series[s.id] || []).map(([x, y]) => ({ x, y })),
    borderColor: PALETTE[i % PALETTE.length],
    backgroundColor: PALETTE[i % PALETTE.length],
    borderWidth: 2, pointRadius: 0, tension: 0.2,
  }));

  const min = data.start;
  const max = data.end;
  const span = max - min;

  // Tell the viewer when the data doesn't cover the whole range.
  const firsts = datasets.map((d) => d.data[0] && d.data[0].x).filter(Boolean);
  const msgs = [];
  if (!firsts.length) {
    msgs.push(range === '30d' || range === 'all'
      ? 'No long-term data yet. Home Assistant builds it hourly, so check back later.'
      : 'No data for this period.');
  } else if (range !== 'all' && Math.min(...firsts) - min > 0.1 * span) {
    msgs.push(`Data starts ${new Date(Math.min(...firsts)).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}.`);
  }
  if (data.source === 'stats') msgs.push(range === 'all' ? 'Daily averages.' : 'Hourly averages.');
  $('chart-msg').textContent = msgs.join(' ');

  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const grid = dark ? '#374151' : '#e5e7eb';
  const tick = dark ? '#9ca3af' : '#6b7280';
  const ticks = makeTicks(min, max);

  if (chart) chart.destroy();
  chart = new Chart($('chart'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: {
          type: 'linear', min, max, grid: { color: grid },
          afterBuildTicks: (axis) => { axis.ticks = ticks.map((value) => ({ value })); },
          ticks: { color: tick, autoSkip: true, maxRotation: 0, callback: (v) => tickLabel(v, span) },
        },
        y: {
          grid: { color: grid }, ticks: { color: tick },
          title: { display: true, text: axisTitle, color: tick },
          ...(chartKind === 'humidity' || chartKind === 'tanks' ? { min: 0, max: 100 } : {}),
        },
      },
      plugins: {
        legend: { labels: { color: tick, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].parsed.x).toLocaleString([], span > 45 * DAY
              ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
              : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
            label: (item) => `${item.dataset.label}: ${Math.round(item.parsed.y * 10) / 10}`,
          },
        },
      },
    },
  });
}

// ---------- CSV of the chart (v1.4) ----------
// The server builds it from the same data as the chart: one column per line.
// On Temperature and Humidity, a checkbox adds the other one (one tick carries across both tabs).
function updateExport() {
  const canCombine = chartKind === 'temps' || chartKind === 'humidity';
  $('combine-wrap').hidden = !canCombine;
  $('combine-text').textContent = chartKind === 'temps' ? 'Include humidity' : 'Include temperature';
  const combine = canCombine && $('combine').checked ? '&combine=1' : '';
  $('dl-csv').href = `api/export.csv?range=${chartRange}&kind=${chartKind}${combine}`;
}

// ---------- Pages ----------
const PAGE_TITLES = { overview: 'Overview', rooms: 'Rooms', tanks: 'Water tanks',
  weather: 'Weather & A/C', network: 'Wi-Fi network', data: 'Data' };
let currentPage = 'overview';

function navLink(page) { return document.querySelector(`.sidebar a[data-page="${page}"]`); }

function showPage() {
  let page = location.hash.replace('#', '') || 'overview';
  if (!PAGE_TITLES[page] || navLink(page).hidden) page = 'overview';
  currentPage = page;
  document.querySelectorAll('.page').forEach((el) => { el.hidden = el.dataset.page !== page; });
  document.querySelectorAll('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  $('page-title').textContent = page === 'overview' ? config.title : PAGE_TITLES[page];
  window.scrollTo(0, 0);
  if (page === 'data') loadChart();
}

// ---------- Start ----------
async function init() {
  config = await (await fetch('api/config')).json();
  document.title = config.title;
  $('brand').textContent = config.title;
  buildHouse();
  buildTanks();
  buildOptional();
  $('tank-note').textContent = `Tanks turn red at ${config.tank_alert_threshold}% full.`;
  connectStream();
  showPage();
  updateExport();
  $('combine').addEventListener('change', updateExport);
  window.addEventListener('hashchange', showPage);

  document.querySelectorAll('#kind-tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#kind-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    chartKind = b.dataset.kind;
    updateExport();
    loadChart();
  }));
  document.querySelectorAll('#range-tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#range-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    chartRange = b.dataset.range;
    updateExport();
    loadChart();
  }));
  setInterval(loadChart, 5 * 60e3);   // refresh history every 5 minutes (only on the Data page)
  setInterval(render, 60e3);          // re-check stale sensors
  if (config.radar_station) setInterval(refreshRadar, 10 * 60e3);
}

init().catch(() => { $('status-text').textContent = 'Could not load the page settings.'; });
