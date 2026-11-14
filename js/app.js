// RadioMap APC 38 : interface (carte, stations, scénarios).
import {
  EQUIPMENT, TERMINALS, DEFAULT_PARAMS, DEFAULT_STATIONS, STATION_COLORS,
  QUALITY, DEAD_COLOR, allowedLoss, dbmFromW,
} from './config.js';
import { computeCoverage, lookupLoss } from './coverage.js';
import { renderComposite, hexToRgb } from './render.js';
import { lineProfile, elevationAt } from './dem.js';
import { pathLoss } from './propagation.js';
import { drawProfile } from './profile.js';

const STORE = 'radiomap-apc38-v1';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDb = (m) => `${m >= 0 ? '+' : ''}${m.toFixed(0)} dB`;

// ---------------------------------------------------------------- État
const newId = () => Math.random().toString(36).slice(2, 9);

function makeStation(type, lat, lon, name) {
  const e = EQUIPMENT[type];
  return {
    id: newId(), name: name || nextName(type), type, lat, lon,
    height: e.height, radiusKm: e.radiusKm, txW: e.txW, gainDbi: e.gainDbi,
    cableDb: e.cableDb, sensDbm: e.sensDbm, color: nextColor(), enabled: true,
  };
}
function nextColor() {
  const used = new Set((state?.stations || []).map((s) => s.color));
  return STATION_COLORS.find((c) => !used.has(c)) || STATION_COLORS[(state?.stations.length || 0) % STATION_COLORS.length];
}
function nextName(type) {
  const base = EQUIPMENT[type].short;
  const n = (state?.stations || []).filter((s) => s.type === type).length + 1;
  return `${base} ${n}`;
}
function defaultState() {
  const st = { params: { ...DEFAULT_PARAMS }, stations: [], view: { lat: 45.17, lon: 5.76, zoom: 11 } };
  state = st;
  st.stations = DEFAULT_STATIONS.map((d) => makeStation(d.type, d.lat, d.lon, d.name));
  return st;
}
function sanitize(obj) {
  const st = { params: { ...DEFAULT_PARAMS, ...(obj.params || {}) }, stations: [], view: obj.view || { lat: 45.17, lon: 5.76, zoom: 11 } };
  for (const s of obj.stations || []) {
    if (!EQUIPMENT[s.type] || !Number.isFinite(+s.lat) || !Number.isFinite(+s.lon)) continue;
    const e = EQUIPMENT[s.type];
    st.stations.push({
      id: s.id || newId(), name: String(s.name || e.short).slice(0, 60), type: s.type,
      lat: +s.lat, lon: +s.lon, height: num(s.height, e.height), radiusKm: num(s.radiusKm, e.radiusKm),
      txW: num(s.txW, e.txW), gainDbi: num(s.gainDbi, e.gainDbi), cableDb: num(s.cableDb, e.cableDb),
      sensDbm: num(s.sensDbm, e.sensDbm), color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : STATION_COLORS[0],
      enabled: s.enabled !== false,
    });
  }
  return st;
}
const num = (v, d) => (Number.isFinite(+v) && v !== '' && v !== null ? +v : d);

function encodeShare() {
  const json = JSON.stringify({ params: state.params, stations: state.stations.map(({ id, ...s }) => s) });
  const bytes = new TextEncoder().encode(json);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeShare(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}
function loadState() {
  const m = location.hash.match(/[#&]s=([^&]+)/);
  if (m) {
    try {
      const st = sanitize(decodeShare(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
      shared = true;
      return st;
    } catch (e) { console.warn('Lien de partage invalide', e); }
  }
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return sanitize(JSON.parse(raw));
  } catch (e) { console.warn(e); }
  return defaultState();
}
const save = () => localStorage.setItem(STORE, JSON.stringify(state));

let state = null;
let shared = false;
state = loadState();
const results = new Map(); // id -> { key, res }
const linkCache = new Map(); // clé géométrique -> affaiblissement (dB)

const terminal = () => TERMINALS[state.params.terminal] || TERMINALS.PORTATIF;
const covKey = (s) => [s.lat.toFixed(5), s.lon.toFixed(5), s.height, s.radiusKm, terminal().height, state.params.fMHz].join('|');
const stationById = (id) => state.stations.find((s) => s.id === id);

// ---------------------------------------------------------------- Carte
const ign = (layer, fmt, style = 'normal') =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${style}` +
  `&FORMAT=${fmt}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
const IGN_ATTR = '© <a href="https://www.ign.fr/">IGN</a> Géoplateforme';
const baseLayers = {
  'Plan IGN': L.tileLayer(ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'), { maxZoom: 19, maxNativeZoom: 19, attribution: IGN_ATTR }),
  'Topographique (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' }),
  'Photos aériennes IGN': L.tileLayer(ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), { maxZoom: 19, maxNativeZoom: 19, attribution: IGN_ATTR }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© contributeurs OpenStreetMap' }),
};
const shadeLayer = L.tileLayer(ign('ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW', 'image/png', 'estompage_grayscale'),
  { maxZoom: 19, maxNativeZoom: 15, opacity: 0.35, attribution: IGN_ATTR });

const map = L.map('map', { zoomControl: true }).setView([state.view.lat, state.view.lon], state.view.zoom);
baseLayers['Plan IGN'].addTo(map);
const coverageGroup = L.layerGroup().addTo(map);
const linksLayer = L.layerGroup().addTo(map);
const markersLayer = L.layerGroup().addTo(map);
const profileLine = L.layerGroup().addTo(map);
L.control.layers(baseLayers, { 'Ombrage du relief': shadeLayer, 'Couverture radio': coverageGroup, 'Liaisons': linksLayer },
  { position: 'topright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
map.on('moveend', () => {
  const c = map.getCenter();
  state.view = { lat: +c.lat.toFixed(5), lon: +c.lng.toFixed(5), zoom: map.getZoom() };
  save();
});

// Coordonnées sous le curseur
const coordsCtl = L.control({ position: 'bottomleft' });
coordsCtl.onAdd = () => L.DomUtil.create('div', 'coords');
coordsCtl.addTo(map);
map.on('mousemove', (e) => { coordsCtl.getContainer().textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`; });

// Recherche de lieu (géocodeur IGN)
const searchCtl = L.control({ position: 'topleft' });
searchCtl.onAdd = () => {
  const div = L.DomUtil.create('div', 'search');
  div.innerHTML = '<input type="search" placeholder="Rechercher un lieu…" aria-label="Rechercher un lieu"><ul></ul>';
  L.DomEvent.disableClickPropagation(div); L.DomEvent.disableScrollPropagation(div);
  const input = $('input', div), ul = $('ul', div);
  let t, ctrl;
  input.addEventListener('input', () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 3) { ul.innerHTML = ''; return; }
    t = setTimeout(async () => {
      ctrl?.abort(); ctrl = new AbortController();
      try {
        const urls = ['poi', 'address'].map((idx) =>
          `https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=5&index=${idx}&lat=45.2&lon=5.75`);
        const res = await Promise.all(urls.map((u) => fetch(u, { signal: ctrl.signal }).then((r) => r.json()).catch(() => ({ features: [] }))));
        const feats = res.flatMap((r) => r.features || []).slice(0, 8);
        ul.innerHTML = feats.map((f, i) => {
          const p = f.properties;
          const name = Array.isArray(p.name) ? p.name[0] : (p.name || p.label);
          const sub = p.label && p.label !== name ? p.label : [Array.isArray(p.city) ? p.city[0] : p.city, Array.isArray(p.category) ? p.category[0] : p.category].filter(Boolean).join(' · ');
          return `<li data-i="${i}">${esc(name)}<br><small>${esc(sub || '')}</small></li>`;
        }).join('');
        ul.onclick = (ev) => {
          const li = ev.target.closest('li'); if (!li) return;
          const [lon, lat] = feats[+li.dataset.i].geometry.coordinates;
          map.flyTo([lat, lon], 14); ul.innerHTML = '';
        };
      } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
    }, 300);
  });
  return div;
};
searchCtl.addTo(map);

// Légende
const legendCtl = L.control({ position: 'bottomright' });
legendCtl.onAdd = () => {
  const d = L.DomUtil.create('div', 'legend');
  L.DomEvent.disableClickPropagation(d);
  if (window.innerWidth <= 760) d.classList.add('min');
  d.addEventListener('click', (e) => { if (e.target.closest('h4')) d.classList.toggle('min'); });
  return d;
};
legendCtl.addTo(map);

// ---------------------------------------------------------------- Marqueurs
const markers = new Map();
function iconFor(s) {
  const e = EQUIPMENT[s.type];
  const cls = `st-icon ${e.role === 'relais' ? 'relais' : ''} ${s.enabled ? '' : 'off'}`;
  return L.divIcon({ className: '', html: `<div class="${cls}" style="background:${s.color}"><span>${e.letter}</span></div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
}
function syncMarkers() {
  for (const [id, m] of markers) if (!stationById(id)) { markersLayer.removeLayer(m); markers.delete(id); }
  for (const s of state.stations) {
    let m = markers.get(s.id);
    if (!m) {
      m = L.marker([s.lat, s.lon], { draggable: true, autoPan: true }).addTo(markersLayer);
      m.on('dragend', () => {
        const st = stationById(s.id); const ll = m.getLatLng();
        st.lat = +ll.lat.toFixed(6); st.lon = +ll.lng.toFixed(6);
        changed({ geometry: true });
      });
      m.on('click', () => { openEditors.add(s.id); renderStations(); scrollToStation(s.id); });
      markers.set(s.id, m);
    }
    m.setLatLng([s.lat, s.lon]);
    m.setIcon(iconFor(s));
    m.unbindTooltip().bindTooltip(esc(s.name), { permanent: true, direction: 'right', offset: [14, 0], className: 'st-label' });
  }
}

// ---------------------------------------------------------------- Panneau stations
const openEditors = new Set();
const addType = $('#add-type');
addType.innerHTML = Object.entries(EQUIPMENT).map(([k, e]) => `<option value="${k}">${esc(e.label)}</option>`).join('');
addType.value = 'SLR1000';

function field(s, k, label, step = 'any', type = 'number', extra = '') {
  return `<label class="${extra}">${label}<input type="${type}" data-k="${k}" value="${esc(s[k])}" step="${step}"></label>`;
}
function renderStations() {
  const term = terminal();
  $('#stations').innerHTML = state.stations.map((s) => {
    const e = EQUIPMENT[s.type];
    const open = openEditors.has(s.id);
    const allowed = allowedLoss(s, term, state.params.marginDb);
    return `<div class="station ${s.enabled ? '' : 'off'}" data-id="${s.id}">
      <div class="st-head">
        <input type="checkbox" class="st-en" ${s.enabled ? 'checked' : ''} title="Inclure dans le calcul">
        <span class="swatch" style="background:${s.color}"></span>
        <div class="st-title"><b>${esc(s.name)}</b><small>${esc(e.short)} · ${s.height} m · ${s.radiusKm} km</small></div>
        <button class="st-zoom" title="Centrer la carte">⌖</button>
        <button class="st-edit" title="Modifier">${open ? '▴' : '✎'}</button>
        <button class="st-del" title="Supprimer">✕</button>
      </div>
      ${open ? `<div class="st-body"><div class="grid">
        ${field(s, 'name', 'Nom', null, 'text', 'full')}
        <label class="full">Matériel<select data-k="type">${Object.entries(EQUIPMENT).map(([k, q]) => `<option value="${k}" ${k === s.type ? 'selected' : ''}>${esc(q.label)}</option>`).join('')}</select></label>
        ${field(s, 'lat', 'Latitude', '0.00001')}
        ${field(s, 'lon', 'Longitude', '0.00001')}
        ${field(s, 'height', 'Hauteur antenne (m)', '0.5')}
        ${field(s, 'radiusKm', 'Rayon de calcul (km)', '1')}
        ${field(s, 'txW', 'Puissance (W)', '0.5')}
        ${field(s, 'gainDbi', 'Gain antenne (dBi)', '0.5')}
        ${field(s, 'cableDb', 'Pertes câble (dB)', '0.5')}
        ${field(s, 'sensDbm', 'Sensibilité (dBm)', '1')}
        <label>Couleur<input type="color" data-k="color" value="${s.color}"></label>
      </div>
      <div class="budget">Affaiblissement max admissible avec un ${esc(term.label.toLowerCase())} :
        <b>${allowed.toFixed(1)} dB</b> (marge de ${state.params.marginDb} dB déduite, ${dbmFromW(s.txW).toFixed(0)} dBm émis)</div>
      </div>` : ''}
    </div>`;
  }).join('') || '<p class="muted">Aucune station. Ajoutez-en une ci-dessous.</p>';
}
function scrollToStation(id) {
  $(`.station[data-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#stations').addEventListener('click', (ev) => {
  const card = ev.target.closest('.station'); if (!card) return;
  const s = stationById(card.dataset.id);
  if (ev.target.closest('.st-del')) {
    if (!confirm(`Supprimer « ${s.name} » ?`)) return;
    state.stations = state.stations.filter((x) => x !== s);
    results.delete(s.id); openEditors.delete(s.id);
    changed({ geometry: true });
  } else if (ev.target.closest('.st-zoom')) {
    map.flyTo([s.lat, s.lon], Math.max(map.getZoom(), 12));
  } else if (ev.target.closest('.st-edit') || ev.target.closest('.st-title')) {
    openEditors.has(s.id) ? openEditors.delete(s.id) : openEditors.add(s.id);
    renderStations();
  }
});
$('#stations').addEventListener('change', (ev) => {
  const card = ev.target.closest('.station'); if (!card) return;
  const s = stationById(card.dataset.id);
  if (ev.target.classList.contains('st-en')) { s.enabled = ev.target.checked; changed({ geometry: true }); return; }
  const k = ev.target.dataset.k; if (!k) return;
  let v = ev.target.value;
  if (k === 'type') {
    const e = EQUIPMENT[v];
    Object.assign(s, { type: v, height: e.height, radiusKm: e.radiusKm, txW: e.txW, gainDbi: e.gainDbi, cableDb: e.cableDb, sensDbm: e.sensDbm });
  } else if (k === 'name' || k === 'color') {
    s[k] = v || s[k];
  } else {
    v = parseFloat(v);
    if (!Number.isFinite(v)) { renderStations(); return; }
    if (k === 'radiusKm') v = Math.min(Math.max(v, 1), 60);
    if (k === 'height') v = Math.min(Math.max(v, 0.5), 200);
    if (k === 'txW') v = Math.max(v, 0.01);
    s[k] = v;
  }
  changed({ geometry: true });
});

// Ajout d'une station
let placing = null;
function setPlacing(type) {
  placing = type;
  $('#place-hint').hidden = !type;
  $('#map').classList.toggle('placing', !!type);
}
$('#add-place').addEventListener('click', () => {
  setPlacing(addType.value);
  if (window.innerWidth <= 760) document.body.classList.add('collapsed');
});
$('#place-cancel').addEventListener('click', () => setPlacing(null));
function addStation(type, lat, lon) {
  const s = makeStation(type, +lat.toFixed(6), +lon.toFixed(6));
  state.stations.push(s);
  openEditors.clear();
  openEditors.add(s.id);
  changed({ geometry: true });
  if (window.innerWidth <= 760) document.body.classList.remove('collapsed');
  scrollToStation(s.id);
}

// ---------------------------------------------------------------- Paramètres
const P = {
  terminal: $('#p-terminal'), mode: $('#p-mode'), opacity: $('#p-opacity'), showDead: $('#p-dead'),
  showLinks: $('#p-links'), auto: $('#p-auto'), fMHz: $('#p-f'), marginDb: $('#p-margin'), extraLossDb: $('#p-extra'),
};
P.terminal.innerHTML = Object.entries(TERMINALS).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('');
function syncParamsForm() {
  for (const [k, el] of Object.entries(P)) {
    if (el.type === 'checkbox') el.checked = !!state.params[k]; else el.value = state.params[k];
  }
}
for (const [k, el] of Object.entries(P)) {
  el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (['opacity', 'fMHz', 'marginDb', 'extraLossDb'].includes(k)) {
      v = parseFloat(v);
      if (!Number.isFinite(v)) { syncParamsForm(); return; }
    }
    state.params[k] = v;
    save();
    if (k === 'opacity') { coverageGroup.eachLayer((l) => l.setOpacity(v)); return; }
    if (k === 'auto') { if (v) runCompute(); else updateComputeButton(); return; }
    if (k === 'showLinks') { renderLinks(); return; }
    // Fréquence et terminal changent la géométrie du calcul, le reste seulement l'affichage.
    changed({ geometry: k === 'fMHz' || k === 'terminal' });
  });
}
$('#compute').addEventListener('click', () => runCompute(true));

// ---------------------------------------------------------------- Calcul
let computing = false, pending = false, timer = null;

function changed({ geometry }) {
  save();
  syncMarkers();
  renderStations();
  refreshOverlay();
  if (geometry) scheduleCompute(); else renderLinks();
}
function needsCompute() {
  return state.stations.some((s) => s.enabled && results.get(s.id)?.key !== covKey(s));
}
function updateComputeButton() {
  $('#compute').classList.toggle('stale', !state.params.auto && needsCompute());
}
function scheduleCompute() {
  clearTimeout(timer);
  updateComputeButton();
  if (state.params.auto) timer = setTimeout(() => runCompute(), 250);
}
function setStatus(text, frac, error = false) {
  const el = $('#status');
  el.hidden = !text;
  el.classList.toggle('error', error);
  $('.txt', el).textContent = text || '';
  $('.bar div', el).style.width = `${Math.round((frac ?? 0) * 100)}%`;
  $('.bar', el).style.visibility = frac == null ? 'hidden' : 'visible';
}

async function runCompute() {
  if (computing) { pending = true; return; }
  computing = true;
  try {
    do {
      pending = false;
      const term = terminal();
      const todo = state.stations.filter((s) => s.enabled && results.get(s.id)?.key !== covKey(s));
      for (let i = 0; i < todo.length; i++) {
        const s = { ...todo[i] };
        const key = covKey(s);
        const t0 = performance.now();
        const res = await computeCoverage(s, { rxH: term.height, fMHz: state.params.fMHz },
          (phase, f) => setStatus(`${s.name} : ${phase}`, (i + f) / todo.length));
        console.info(`Couverture ${s.name} : ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        if (stationById(s.id)) results.set(s.id, { key, res });
        refreshOverlay();
        if (pending) break;
      }
    } while (pending);
    setStatus('');
    await updateLinks();
  } catch (e) {
    console.error(e);
    setStatus(`Erreur : ${e.message}. Cliquez sur « Calculer » pour réessayer.`, null, true);
  } finally {
    computing = false;
    updateComputeButton();
  }
}

// ---------------------------------------------------------------- Rendu de la couverture
let overlayUrl = null, lastStats = null, renderSeq = 0;
function activeLayers() {
  const term = terminal();
  return state.stations
    .filter((s) => s.enabled && results.get(s.id)?.key === covKey(s))
    .map((s) => ({ st: s, res: results.get(s.id).res, allowed: allowedLoss(s, term, state.params.marginDb), rgb: hexToRgb(s.color) }));
}
function refreshOverlay() {
  const seq = ++renderSeq;
  const layers = activeLayers();
  const out = renderComposite(layers, { mode: state.params.mode, extraLossDb: state.params.extraLossDb, marginDb: state.params.marginDb, showDead: state.params.showDead });
  lastStats = out?.stats || null;
  renderLegend();
  if (!out) { coverageGroup.clearLayers(); return; }
  out.canvas.toBlob((blob) => {
    if (seq !== renderSeq) return;
    const url = URL.createObjectURL(blob);
    coverageGroup.clearLayers();
    L.imageOverlay(url, out.bounds, { opacity: state.params.opacity, interactive: false, className: 'coverage' }).addTo(coverageGroup);
    if (overlayUrl) URL.revokeObjectURL(overlayUrl);
    overlayUrl = url;
  });
}
function renderLegend() {
  const el = legendCtl.getContainer();
  const sw = (rgb, a = 1) => `<span class="sw" style="background:rgba(${rgb.join(',')},${a})"></span>`;
  let html = `<h4>Couverture vue par un ${esc(terminal().label.toLowerCase())}</h4>`;
  if (state.params.mode === 'station') {
    for (const l of activeLayers()) html += `<div class="it">${sw(l.rgb)}${esc(l.st.name)}</div>`;
    html += `<div class="it muted">Teinte pâle : liaison instable</div>`;
  } else {
    for (const q of QUALITY) html += `<div class="it">${sw(q.color)}${esc(q.label)}</div>`;
  }
  if (state.params.showDead) html += `<div class="it">${sw(DEAD_COLOR, 0.6)}Pas de liaison</div>`;
  if (lastStats) {
    const tot = lastStats.good + lastStats.unstable + lastStats.dead;
    const pct = (v) => (tot ? Math.round((100 * v) / tot) : 0);
    html += `<div class="st">Zone calculée : ${Math.round(tot)} km²<br>
      Couverte : ${Math.round(lastStats.good)} km² (${pct(lastStats.good)} %)<br>
      Instable : ${pct(lastStats.unstable)} % · Sans liaison : ${pct(lastStats.dead)} %</div>`;
  }
  html += `<div class="st small">Relief seul : forêt et bâti non pris en compte. À confirmer par un essai radio.</div>`;
  el.innerHTML = html;
}

// ---------------------------------------------------------------- Liaisons entre stations
const linkKey = (a, b) => [a.lat, a.lon, a.height, b.lat, b.lon, b.height, state.params.fMHz].join('|');
function linkPairs() {
  const en = state.stations.filter((s) => s.enabled);
  const pairs = [];
  for (let i = 0; i < en.length; i++) for (let j = i + 1; j < en.length; j++) {
    const ra = EQUIPMENT[en[i].type].role, rb = EQUIPMENT[en[j].type].role;
    if (ra === 'relais' && rb === 'relais') continue; // deux relais ne se parlent pas
    pairs.push([en[i], en[j]]);
  }
  return pairs.slice(0, 60);
}
async function updateLinks() {
  const pairs = linkPairs();
  const todo = pairs.filter(([a, b]) => !linkCache.has(linkKey(a, b)));
  for (let i = 0; i < todo.length; i++) {
    const [a, b] = todo[i];
    setStatus(`Liaison ${a.name} ↔ ${b.name}`, i / todo.length);
    const prof = await lineProfile(a, b, 20, 12);
    linkCache.set(linkKey(a, b), pathLoss(prof.s, prof.z, a.height, b.height, state.params.fMHz).total);
  }
  setStatus('');
  renderLinks();
}
function qualityOf(m) {
  if (m >= 10) return ['q-good', 'très bonne', QUALITY[0].color];
  if (m >= 0) return ['q-ok', 'bonne', QUALITY[1].color];
  if (m >= -state.params.marginDb) return ['q-unst', 'instable', QUALITY[2].color];
  return ['q-dead', 'impossible', DEAD_COLOR];
}
function renderLinks() {
  linksLayer.clearLayers();
  const rows = [];
  for (const [a, b] of linkPairs()) {
    const pl = linkCache.get(linkKey(a, b));
    if (pl === undefined) continue;
    const m = allowedLoss(a, b, state.params.marginDb) - pl - state.params.extraLossDb;
    const [cls, lab, rgb] = qualityOf(m);
    rows.push({ a, b, m, cls, lab, rgb });
    if (state.params.showLinks) {
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: `rgb(${rgb.join(',')})`, weight: 3, opacity: 0.85, dashArray: m >= 0 ? null : '6 6' })
        .bindTooltip(`${esc(a.name)} ↔ ${esc(b.name)} : ${fmtDb(m)} (${lab})`, { sticky: true })
        .on('click', () => openProfile(a, b))
        .addTo(linksLayer);
    }
  }
  $('#links').innerHTML = rows.length
    ? `<table>${rows.map((r, i) => `<tr data-i="${i}"><td><span class="dot" style="background:rgb(${r.rgb.join(',')})"></span>${esc(r.a.name)} ↔ ${esc(r.b.name)}</td><td class="m ${r.cls}">${fmtDb(r.m)}</td></tr>`).join('')}</table>
       <p class="muted small">Marge restante après la marge de sécurité. Cliquez pour voir le profil.</p>`
    : '<p class="muted">Ajoutez au moins deux stations (hors paire de relais).</p>';
  $('#links').onclick = (ev) => {
    const tr = ev.target.closest('tr'); if (!tr) return;
    const r = rows[+tr.dataset.i]; openProfile(r.a, r.b);
  };
}

// ---------------------------------------------------------------- Profil
const profileEl = $('#profile');
$('.p-close', profileEl).addEventListener('click', () => { profileEl.hidden = true; profileLine.clearLayers(); });
let lastProfile = null;
async function openProfile(a, b) {
  profileEl.hidden = false;
  const info = $('.p-info', profileEl);
  info.innerHTML = `<span class="t">${esc(a.name)} → ${esc(b.name)}</span> · calcul du profil…`;
  profileLine.clearLayers();
  L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: '#000', weight: 2, dashArray: '4 4' }).addTo(profileLine);
  try {
    const prof = await lineProfile(a, b, 10, 13);
    const f = state.params.fMHz;
    const pl = pathLoss(prof.s, prof.z, a.height, b.height, f);
    const allowed = allowedLoss(a, b, state.params.marginDb);
    const m = allowed - pl.total - state.params.extraLossDb;
    const [cls, lab] = qualityOf(m);
    info.innerHTML = `<span class="t">${esc(a.name)} → ${esc(b.name)}</span> · ${(prof.d / 1000).toFixed(2)} km<br>
      Affaiblissement ${pl.total.toFixed(0)} dB (espace libre ${pl.free.toFixed(0)} + relief ${pl.diff.toFixed(0)}${state.params.extraLossDb ? ` + supp. ${state.params.extraLossDb}` : ''})
      · admissible ${allowed.toFixed(0)} dB · <b class="${cls}">marge ${fmtDb(m)} : ${lab}</b>`;
    lastProfile = { prof, a, b, f };
    drawProfile($('canvas', profileEl), prof, a.height, b.height, f, { a: a.name, b: b.name });
  } catch (e) {
    info.innerHTML += ` <span class="q-dead">Erreur : ${esc(e.message)}</span>`;
  }
}
window.addEventListener('resize', () => {
  if (!profileEl.hidden && lastProfile) {
    const { prof, a, b, f } = lastProfile;
    drawProfile($('canvas', profileEl), prof, a.height, b.height, f, { a: a.name, b: b.name });
  }
});

// ---------------------------------------------------------------- Clic sur la carte
map.on('click', async (e) => {
  const { lat, lng } = e.latlng;
  if (placing) { const t = placing; setPlacing(null); addStation(t, lat, lng); return; }
  const term = terminal();
  const point = { ...term, name: 'Point', lat, lon: lng };
  const rows = state.stations.filter((s) => s.enabled).map((s) => {
    const r = results.get(s.id);
    const pl = r && r.key === covKey(s) ? lookupLoss(r.res, lat, lng) : NaN;
    const m = allowedLoss(s, term, state.params.marginDb) - pl - state.params.extraLossDb;
    return { s, m };
  }).sort((x, y) => (Number.isNaN(y.m) ? -1 : Number.isNaN(x.m) ? 1 : y.m - x.m));
  const html = `<div class="pt-pop">
    <b>${lat.toFixed(5)}, ${lng.toFixed(5)}</b> · alt. <span class="alt">…</span><br>
    <small>${esc(term.label)}</small>
    ${rows.length ? `<table>${rows.map(({ s, m }) => {
      const [cls, lab] = Number.isNaN(m) ? ['muted', 'hors zone'] : qualityOf(m);
      return `<tr><td><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</td>
        <td class="m ${cls}">${Number.isNaN(m) ? '–' : fmtDb(m)}</td><td class="${cls}">${lab}</td>
        <td><button data-prof="${s.id}" title="Profil de la liaison">Profil</button></td></tr>`;
    }).join('')}</table>` : ''}
    <div class="add-here"><select>${Object.entries(EQUIPMENT).map(([k, q]) => `<option value="${k}">${esc(q.label)}</option>`).join('')}</select>
      <button class="add-btn">Ajouter ici</button></div>
  </div>`;
  const pop = L.popup({ maxWidth: 360 }).setLatLng(e.latlng).setContent(html).openOn(map);
  const el = pop.getElement();
  $('.add-here select', el).value = addType.value;
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.prof) { map.closePopup(); openProfile(stationById(b.dataset.prof), point); }
    if (b.classList.contains('add-btn')) { map.closePopup(); addStation($('.add-here select', el).value, lat, lng); }
  });
  try { $('.alt', el).textContent = `${Math.round(await elevationAt(lat, lng))} m`; } catch { $('.alt', el).textContent = '?'; }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setPlacing(null); });

// ---------------------------------------------------------------- Scénario
$('#share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#s=${encodeShare()}`;
  try { await navigator.clipboard.writeText(url); flash('#share', 'Lien copié ✓'); } catch { prompt('Lien du scénario :', url); }
});
$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ app: 'radiomap-apc38', version: 1, ...state }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `radiomap-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#import').addEventListener('change', async (ev) => {
  const file = ev.target.files[0]; if (!file) return;
  try {
    replaceState(sanitize(JSON.parse(await file.text())));
  } catch (e) { alert(`Fichier invalide : ${e.message}`); }
  ev.target.value = '';
});
$('#reset').addEventListener('click', () => {
  if (confirm('Revenir au scénario par défaut ? Les stations actuelles seront supprimées.')) replaceState(defaultState());
});
function replaceState(st) {
  state = st;
  results.clear(); openEditors.clear();
  syncParamsForm();
  map.setView([state.view.lat, state.view.lon], state.view.zoom);
  changed({ geometry: true });
}
function flash(sel, text) {
  const b = $(sel), old = b.textContent; b.textContent = text; setTimeout(() => { b.textContent = old; }, 1500);
}

// Panneau repliable
$('#toggle-sidebar').addEventListener('click', () => {
  document.body.classList.toggle('collapsed');
  setTimeout(() => map.invalidateSize(), 50);
});
if (window.innerWidth <= 760) document.body.classList.add('collapsed');

// ---------------------------------------------------------------- Démarrage
syncParamsForm();
syncMarkers();
renderStations();
renderLegend();
renderLinks();
if (shared && state.stations.length) {
  map.fitBounds(L.latLngBounds(state.stations.map((s) => [s.lat, s.lon])).pad(0.5), { maxZoom: 12 });
}
if (state.params.auto) runCompute(); else updateComputeButton();
