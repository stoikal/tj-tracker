'use strict';

/* TransJakarta live tracker for routes 4K and 10.
 * Positions come from the public TJ MQTT armada feed (anonymous WSS),
 * static route/shelter data from GTFS via js/data.js (scripts/build_data.py).
 */

const BROKER_URL = 'wss://mqtt.tj.co.id:8084/mqtt';
const TOPIC = '/mobile_armada/#';
const TRACKED_ROUTES = ['4K', '10'];
const STALE_MS = 45 * 1000;      // dim markers not updated within 45s
const REMOVE_MS = 120 * 1000;    // drop markers not updated within 120s
const REFRESH_MS = 5 * 1000;     // sidebar / popup countdown refresh

const ROUTE_STYLE = {
  '4K': { color: '#2f6bff', label: '4K' },
  '10': { color: '#e2372f', label: '10' },
};

// Direction filter: keep only buses whose current run heads to this
// destination (set a route's value to null to show both directions).
const ROUTE_DIRECTION_FILTER = { '4K': 'Kejaksaan Agung', '10': 'PGC' };
let directionFilterOn = true;

const DATA = window.TJ_DATA;
const SHELTERS = DATA.shelters;

/* ---------------- state ---------------- */

const buses = new Map();          // bus key -> bus record
const busMarkers = new Map();     // bus key -> L.Marker
let selectedBusKey = null;
let selectedShelterId = null;

/* ---------------- map ---------------- */

// SVG renderer (not canvas): renders immediately even where rAF is throttled.
const map = L.map('map', { zoomControl: true })
  .setView([-6.221, 106.855], 12);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const routeLineLayer = L.layerGroup().addTo(map);
for (const line of DATA.route_lines) {
  const style = ROUTE_STYLE[line.route];
  L.polyline(line.coords, {
    color: style.color,
    weight: 4,
    opacity: 0.5,
    lineJoin: 'round',
    lineCap: 'round',
  })
    .bindTooltip(`${line.route} \u2192 ${line.headsign}`, { sticky: true })
    .addTo(routeLineLayer);
}

document.getElementById('toggle-lines').addEventListener('change', (e) => {
  if (e.target.checked) routeLineLayer.addTo(map);
  else map.removeLayer(routeLineLayer);
});

// Direction filter toggle (4K -> Kejaksaan Agung, 10 -> PGC by default).
const dirDests = [...new Set(Object.values(ROUTE_DIRECTION_FILTER).filter(Boolean))];
document.getElementById('direction-toggle-label').textContent =
  dirDests.length ? `Only buses toward ${dirDests.join(' / ')}` : 'No direction filter configured';
document.getElementById('toggle-direction').addEventListener('change', (e) => {
  directionFilterOn = e.target.checked;
  syncAllMarkers();
  refreshViews();
});

// Initial view covers both route corridors.
const allPts = DATA.route_lines.flatMap((l) => l.coords);
if (allPts.length) map.fitBounds(L.latLngBounds(allPts), { padding: [30, 30] });

/* ---------------- shelters ---------------- */

function busIcon(route, bearing, stale) {
  const style = ROUTE_STYLE[route];
  return L.divIcon({
    className: 'bus-icon',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    html: `
      <div class="bus-arrow ${route === '10' ? 'red' : 'blue'}${stale ? ' stale' : ''}" style="--rot:${bearing || 0}deg">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2 L19 21 L12 16.5 L5 21 Z" fill="#fff"/>
        </svg>
      </div>`,
  });
}

function shelterIcon(shelter) {
  return L.divIcon({
    className: 'shelter-icon',
    iconSize: [18, 18],
    iconAnchor: [9, 18],
    popupAnchor: [6, -16],
    html: `
      <div class="shelter-pin ${shelter.route === '10' ? 'red' : 'blue'}"></div>
      <div class="shelter-label">${shelter.label}</div>`,
  });
}

function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function fmtEta(minutes) {
  if (minutes == null) return '\u2014';
  if (minutes < 1) return 'arriving';
  return `${Math.round(minutes)} min`;
}

function norm(s) {
  return (s || '').toLowerCase().trim();
}

/**
 * True when the bus's CURRENT run heads toward `dest`. The headsign of the
 * upcoming stop entries is authoritative (loop trips like 4K-L03 carry both
 * directions and their trip_headsign can name both ends); trip_headsign is
 * only the fallback when no stop data is present.
 */
function busHeadedTo(bus, dest) {
  const d = norm(dest);
  if (!d) return true;
  const stops = bus.stops || [];
  const next = stops.find((s) => s.eta != null) || stops[0];
  const h = norm(next && next.headsign) || norm(bus.trip_headsign);
  return h.includes(d);
}

function isBusVisible(bus) {
  if (!directionFilterOn) return true;
  const dest = ROUTE_DIRECTION_FILTER[bus.route_code];
  return dest ? busHeadedTo(bus, dest) : true;
}

/**
 * Find the ETA of `bus` at `shelter`, matching the direction-specific gate
 * (or its parent halte) and the stop headsign for the shelter's destination.
 * Returns {etaMin, stopName} or null.
 */
function matchShelter(bus, shelter) {
  const dest = norm(shelter.dest);
  const heads = norm(bus.stops && bus.stops.length ? bus.stops[0].headsign || bus.trip_headsign : bus.trip_headsign);
  for (const st of bus.stops || []) {
    const gateHit =
      st.stop_id === shelter.gate_id ||
      (shelter.parent_id && (st.parent_stop_id === shelter.parent_id || st.stop_id === shelter.parent_id)) ||
      st.parent_stop_id === shelter.gate_id;
    if (!gateHit) continue;
    const h = norm(st.headsign) || heads;
    if (!h.includes(dest)) continue;
    return { etaMin: st.eta != null ? st.eta : null, stopName: st.name };
  }
  // Fallback: aggregate ETA map (keyed by parent/gate id) when the stop list
  // is truncated, but only if the bus headsign matches the shelter direction.
  if (heads.includes(dest)) {
    const map_ = bus.eta_by_parent_stop_id || {};
    const v = map_[shelter.gate_id] ?? map_[shelter.parent_id];
    if (v != null) return { etaMin: v, stopName: null };
  }
  return null;
}

/** Live-remaining ETA in minutes for a match recorded at message receipt. */
function remainingEta(match) {
  if (!match || match.etaMin == null) return null;
  const elapsedMin = (Date.now() - match.receivedAt) / 60000;
  return Math.max(0, match.etaMin - elapsedMin);
}

function shelterUpcoming(shelter) {
  const rows = [];
  for (const [key, bus] of buses) {
    const m = bus.shelterMatches[shelter.id];
    const eta = remainingEta(m);
    if (eta == null) continue;
    rows.push({ key, bus, eta, stopName: m.stopName });
  }
  rows.sort((a, b) => a.eta - b.eta);
  return rows;
}

function shelterPopupHtml(shelter) {
  const rows = shelterUpcoming(shelter);
  const list = rows.length
    ? rows.slice(0, 8).map((r) => `
        <div>\u25b6 <b>${r.bus.bus_body_no}</b> \u00b7 ${r.bus.route_code} \u2192 ${r.bus.trip_headsign}
        \u2014 <b style="color:#2fbf71">${fmtEta(r.eta)}</b></div>`).join('')
    : '<div class="muted">No tracked bus heading here right now.</div>';
  return `
    <div class="popup">
      <h3>${shelter.label}</h3>
      <div class="muted">${shelter.detail} &middot; ${shelter.stop_name || ''}</div>
      <table>
        <tr><td class="k">Coordinates</td><td>${shelter.lat.toFixed(5)}, ${shelter.lon.toFixed(5)}</td></tr>
        <tr><td class="k">Gate stop</td><td>${shelter.gate_id}</td></tr>
      </table>
      <div class="eta-list"><b>Upcoming buses</b>${list}</div>
    </div>`;
}

const shelterMarkers = new Map();
for (const shelter of SHELTERS) {
  const marker = L.marker([shelter.lat, shelter.lon], {
    icon: shelterIcon(shelter),
    zIndexOffset: 500,
  }).addTo(map);
  marker.bindPopup(shelterPopupHtml(shelter), { maxWidth: 320 });
  marker.on('popupopen', (e) => e.popup.setContent(shelterPopupHtml(shelter)));
  shelterMarkers.set(shelter.id, marker);
}

/* ---------------- shelter shortcuts ---------------- */

const shelterButtons = document.getElementById('shelter-buttons');
SHELTERS.forEach((shelter, i) => {
  const btn = document.createElement('button');
  btn.className = `shelter-btn ${shelter.route === '10' ? 'route-10' : ''}`;
  btn.innerHTML = `
    <div class="name">${i + 1}. ${shelter.label}</div>
    <div class="detail">${shelter.detail}</div>
    <div class="eta none" id="shelter-eta-${shelter.id}">no buses yet</div>`;
  btn.addEventListener('click', () => snapToShelter(shelter));
  shelterButtons.appendChild(btn);
});

function snapToShelter(shelter) {
  selectedShelterId = shelter.id;
  // Instant snap (no animation) so it works even where rAF is throttled.
  map.setView([shelter.lat, shelter.lon], 16, { animate: false });
  shelterMarkers.get(shelter.id).openPopup();
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= SHELTERS.length) {
    snapToShelter(SHELTERS[n - 1]);
  } else if (e.key === '0' || e.key.toLowerCase() === 'r') {
    map.fitBounds(L.latLngBounds(allPts), { padding: [30, 30], animate: false });
  }
});

/* ---------------- bus markers & popup ---------------- */

function busPopupHtml(bus) {
  const stripId = (s) => (s || '').replace(/^[^-]+-/, '');
  const cur = stripId(bus.curr_stops) || (bus.stops && bus.stops[0] ? bus.stops[0].name : '');
  const next = stripId(bus.next_stops);
  const etaRows = SHELTERS.map((sh) => {
    const m = bus.shelterMatches[sh.id];
    const eta = remainingEta(m);
    return eta == null
      ? null
      : `<div><span class="chip ${sh.route === '10' ? 'red' : 'blue'}">${sh.route}</span> ${sh.label} \u2014 <b style="color:#2fbf71">${fmtEta(eta)}</b></div>`;
  }).filter(Boolean);
  return `
    <div class="popup">
      <h3><span class="chip ${bus.route_code === '10' ? 'red' : 'blue'}">${bus.route_code}</span> ${bus.bus_body_no}</h3>
      <div class="muted">\u2192 ${bus.trip_headsign || '—'}${bus.bus_type ? ' &middot; ' + bus.bus_type : ''}</div>
      <table>
        <tr><td class="k">Current stop</td><td>${cur || '\u2014'}</td></tr>
        <tr><td class="k">Next stop</td><td>${next || '\u2014'}${bus.next_gate_eta != null ? ` (${Math.max(1, Math.round(bus.next_gate_eta))} min)` : ''}</td></tr>
        <tr><td class="k">Position</td><td>${bus.lat.toFixed(5)}, ${bus.lon.toFixed(5)}</td></tr>
        <tr><td class="k">Updated</td><td>${fmtAge(Date.now() - bus.receivedAt)}</td></tr>
      </table>
      ${etaRows.length ? `<div class="eta-list"><b>Watched shelters</b>${etaRows.join('')}</div>` : ''}
    </div>`;
}

function upsertBus(msg, topic) {
  const route = String(msg.route_code || '').toUpperCase();
  const key = topic.split('/').pop() || msg.bus_body_no;
  const lat = Number(msg.snap_latitude) || Number(msg.latitude);
  const lon = Number(msg.snap_longitude) || Number(msg.longitude);
  if (!isFinite(lat) || !isFinite(lon)) return;

  let bus = buses.get(key);
  if (!bus) {
    bus = { key, route_code: route };
    buses.set(key, bus);
  }
  Object.assign(bus, msg, {
    route_code: route,
    lat,
    lon,
    bearing: Number(msg.bearing) || 0,
    receivedAt: Date.now(),
    shelterMatches: {},
  });
  for (const sh of SHELTERS) {
    const m = matchShelter(bus, sh);
    if (m) bus.shelterMatches[sh.id] = { ...m, receivedAt: bus.receivedAt };
  }

  ensureMarker(key);
}

/**
 * Create/update/remove a bus marker according to the direction filter.
 * The bus record itself is kept regardless, so toggling the filter can
 * instantly show buses already heard from.
 */
function ensureMarker(key) {
  const bus = buses.get(key);
  if (!bus) return;
  let marker = busMarkers.get(key);
  if (!isBusVisible(bus)) {
    if (marker) {
      map.removeLayer(marker);
      busMarkers.delete(key);
      if (selectedBusKey === key) selectedBusKey = null;
    }
    return;
  }
  if (!marker) {
    marker = L.marker([bus.lat, bus.lon], { icon: busIcon(bus.route_code, bus.bearing, false), zIndexOffset: 100 });
    marker.on('click', () => { selectedBusKey = key; renderBusList(); });
    marker.bindPopup(busPopupHtml(bus), { maxWidth: 320 });
    marker.addTo(map);
    busMarkers.set(key, marker);
  } else {
    marker.setLatLng([bus.lat, bus.lon]);
    marker.setIcon(busIcon(bus.route_code, bus.bearing, false));
    marker.getPopup().setContent(busPopupHtml(bus));
  }
}

/** Re-evaluate marker visibility for every tracked bus (filter toggles). */
function syncAllMarkers() {
  for (const key of buses.keys()) ensureMarker(key);
}

/* ---------------- sidebar rendering ---------------- */

function renderCounts() {
  let n4k = 0, n10 = 0;
  for (const bus of buses.values()) {
    if (!isBusVisible(bus)) continue;
    if (bus.route_code === '4K') n4k++;
    else if (bus.route_code === '10') n10++;
  }
  document.getElementById('count-4k').textContent = n4k;
  document.getElementById('count-10').textContent = n10;
}

function renderBusList() {
  const list = document.getElementById('bus-list');
  const rows = [...buses.values()].filter(isBusVisible).sort((a, b) =>
    a.route_code.localeCompare(b.route_code) || a.bus_body_no.localeCompare(b.bus_body_no));
  if (!rows.length) {
    list.innerHTML = '<div class="empty">Waiting for buses on 4K / 10&hellip;</div>';
    return;
  }
  list.innerHTML = rows.map((bus) => {
    const stale = Date.now() - bus.receivedAt > STALE_MS;
    const etaBits = SHELTERS.map((sh) => {
      const m = bus.shelterMatches[sh.id];
      const eta = remainingEta(m);
      return eta == null ? null : `${sh.label.split(' ').slice(0, 2).join(' ')} ${fmtEta(eta)}`;
    }).filter(Boolean);
    return `
      <div class="bus-row${stale ? ' stale' : ''}" data-key="${bus.key}">
        <span class="chip ${bus.route_code === '10' ? 'red' : 'blue'}">${bus.route_code}</span>
        <div class="info">
          <div class="no">${bus.bus_body_no} <span class="muted">\u00b7 ${fmtAge(Date.now() - bus.receivedAt)}</span></div>
          <div class="dest">\u2192 ${bus.trip_headsign || '—'}</div>
        </div>
        <div class="eta">${etaBits.join('<br>') || ''}</div>
      </div>`;
  }).join('');

  for (const el of list.querySelectorAll('.bus-row')) {
    el.addEventListener('click', () => {
      const bus = buses.get(el.dataset.key);
      if (!bus) return;
      selectedBusKey = bus.key;
      map.setView([bus.lat, bus.lon], 16, { animate: false });
      busMarkers.get(bus.key).openPopup();
    });
  }
}

function renderShelterEtas() {
  for (const sh of SHELTERS) {
    const el = document.getElementById(`shelter-eta-${sh.id}`);
    if (!el) continue;
    const rows = shelterUpcoming(sh);
    if (rows.length) {
      el.textContent = `next: ${rows[0].bus.bus_body_no} \u00b7 ${fmtEta(rows[0].eta)}` +
        (rows.length > 1 ? `  (+${rows.length - 1} more)` : '');
      el.classList.remove('none');
    } else {
      el.textContent = 'no buses yet';
      el.classList.add('none');
    }
  }
}

function sweep() {
  const now = Date.now();
  for (const [key, bus] of buses) {
    const age = now - bus.receivedAt;
    if (age > REMOVE_MS) {
      const marker = busMarkers.get(key);
      if (marker) map.removeLayer(marker);
      busMarkers.delete(key);
      buses.delete(key);
      continue;
    }
    const marker = busMarkers.get(key);
    if (marker) {
      marker.setIcon(busIcon(bus.route_code, bus.bearing, age > STALE_MS));
    }
  }
}

function refreshViews() {
  renderCounts();
  renderBusList();
  renderShelterEtas();
  document.getElementById('bus-updated').textContent =
    `${[...buses.values()].filter(isBusVisible).length} shown`;
  const marker = selectedBusKey && busMarkers.get(selectedBusKey);
  if (marker && marker.isPopupOpen()) {
    marker.getPopup().setContent(busPopupHtml(buses.get(selectedBusKey)));
  }
  for (const sh of SHELTERS) {
    const sm = shelterMarkers.get(sh.id);
    if (sm && sm.isPopupOpen()) sm.getPopup().setContent(shelterPopupHtml(sh));
  }
}

setInterval(refreshViews, REFRESH_MS);
setInterval(sweep, 10000);

/* ---------------- MQTT ---------------- */

// The TJ broker drops connections intermittently (server-side), so the status
// indicator reflects DATA freshness rather than raw socket state.
let lastMsgAt = 0;
let socketConnected = false;

function refreshStatus() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const age = Date.now() - lastMsgAt;
  if (!socketConnected) {
    dot.className = 'dot bad';
    text.textContent = lastMsgAt
      ? `reconnecting\u2026 (last data ${fmtAge(age)})`
      : 'connecting\u2026';
  } else if (!lastMsgAt) {
    dot.className = 'dot';
    text.textContent = 'connected \u00b7 waiting for buses\u2026';
  } else if (age < 30000) {
    dot.className = 'dot ok';
    text.textContent = `live \u00b7 ${[...buses.values()].filter(isBusVisible).length} buses \u00b7 updated ${fmtAge(age)}`;
  } else {
    dot.className = 'dot';
    text.textContent = `connected \u00b7 no data for ${fmtAge(age)}`;
  }
}

function connect() {
  if (typeof mqtt === 'undefined') {
    document.getElementById('status-dot').className = 'dot bad';
    document.getElementById('status-text').textContent = 'mqtt.js failed to load (CDN offline?)';
    return;
  }
  const client = mqtt.connect(BROKER_URL, {
    clientId: 'tjtracker_' + Math.random().toString(16).slice(2, 10),
    reconnectPeriod: 3000,
    connectTimeout: 10000,
    keepalive: 60,
    clean: true,
  });
  window.__tjDebug = { connects: 0, closes: 0, errors: [], client };

  client.on('connect', () => {
    window.__tjDebug.connects++;
    socketConnected = true;
    client.subscribe(TOPIC);
  });
  client.on('close', () => {
    window.__tjDebug.closes++;
    socketConnected = false;
  });
  client.on('error', (err) => {
    window.__tjDebug.errors.push(String(err && err.message || err));
  });

  client.on('message', (topic, payload) => {
    let msg;
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      return;
    }
    const route = String(msg.route_code || '').toUpperCase();
    if (!TRACKED_ROUTES.includes(route)) return;
    lastMsgAt = Date.now();
    upsertBus(msg, topic);
  });

  setInterval(refreshStatus, 2000);
}

connect();
renderBusList();
renderShelterEtas();
