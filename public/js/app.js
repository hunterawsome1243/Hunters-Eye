import { getJson } from './api.js';
import { createFallbacks } from './fallback.js';
import { createDetailPanel } from './ui/detail.js';
import { createFeed } from './ui/feed.js';
import { createSummary } from './ui/summary.js';
import { layerModules } from './layers/index.js';

const STATUS_POLL_MS = 5000;

const map = L.map('map', {
  center: [25, -20],
  zoom: 3,
  minZoom: 2,
  maxZoom: 19,
  worldCopyJump: true,
  zoomControl: false,
  preferCanvas: true,
});
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>'); // no flag: it has to fit a phone

// The map underneath the layers: a vector style (OpenFreeMap's dark one by default,
// set by the server in /api/config) drawn by MapLibre inside Leaflet. It loads on
// its own, so a basemap problem never stops the data layers. Its credit line comes
// from the style's own sources.
async function addBasemap(style) {
  try {
    const { maplibreGL } = await import('/vendor/maplibre-gl-leaflet/leaflet-maplibre-gl.mjs');
    maplibreGL({ style }).addTo(map);
  } catch (err) {
    console.warn('Basemap unavailable:', err.message);
  }
}

// Sidebar: open by default on wide screens.
const sidebarToggle = document.getElementById('sidebar-toggle');
function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  setTimeout(() => map.invalidateSize(), 210); // just after the panel's 200ms slide
}
setSidebar(window.innerWidth > 760);
sidebarToggle.addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));

const layers = [];
const byId = new Map();
const detail = createDetailPanel(document.getElementById('detail'), {
  onClose: () => layers.forEach((l) => l.clearSelection()),
});
const feed = createFeed(document.getElementById('feed'), document.getElementById('feed-count'), {
  isVisible: (entry) => {
    const layer = byId.get(entry.source);
    return !layer || (map.hasLayer(layer.layer) && (layer.acceptsFeed?.(entry) ?? true));
  },
});
const filtersEl = document.getElementById('filters');

let clockOffset = 0; // server clock minus browser clock, from /api/status

const ctx = {
  map,
  clockOffset: () => clockOffset,
  // Give clickable layers (aircraft) first claim on a click at this point.
  pick(containerPoint) {
    return layers.some((l) => map.hasLayer(l.layer) && l.pick?.(containerPoint));
  },
  feed,
  detail,
  addFilter: (node) => filtersEl.append(node),
  select(owner) {
    for (const l of layers) if (l !== owner) l.clearSelection();
    if (window.innerWidth <= 760) setSidebar(false);
  },
  isVisible: (id) => map.hasLayer(byId.get(id).layer),
};

for (const create of layerModules) {
  const layer = create(ctx);
  layers.push(layer);
  byId.set(layer.id, layer);
  if (layer.visible) layer.layer.addTo(map);
}

function setLayerVisible(layer, on) {
  if (on) {
    layer.layer.addTo(map);
    layer.onShow?.();
  } else {
    map.removeLayer(layer.layer);
    layer.onHide?.();
    layer.clearSelection();
    if (detail.key?.startsWith(`${layer.id}:`)) detail.hide();
  }
  feed.refresh();
  summary.render();
}

const summary = createSummary(document.getElementById('summary'), layers, { onToggle: setLayerVisible });

// Health changes become feed entries, so a failing feed is visible in the history too.
const health = new Map();
function noteHealth(s) {
  const layer = byId.get(s.id);
  const state = s.error ? 'error' : s.updatedAt ? 'ok' : 'loading';
  const before = health.get(s.id);
  health.set(s.id, state);
  if (state === before || state === 'loading' || (state === 'ok' && before !== 'error')) return;
  feed.add({
    id: `system:${s.id}:${Date.now()}`,
    source: 'system',
    system: true,
    time: Date.now(),
    color: state === 'error' ? 'var(--bad)' : 'var(--ok)',
    title: state === 'error' ? `${layer.name} feed failed` : `${layer.name} feed recovered`,
    subtitle: state === 'error' ? s.error : `${layer.source} is responding again`,
  });
}

const versions = new Map();
async function loadSource(s) {
  const layer = byId.get(s.id);
  if (!layer || !s.updatedAt || versions.get(s.id) === s.updatedAt) return;
  try {
    const { data, status } = await getJson(`/api/sources/${s.id}`);
    versions.set(s.id, status.updatedAt);
    if (data) layer.update(data);
  } catch (err) {
    console.warn(`Could not load ${s.id}:`, err.message);
  }
}

// Fills in for sources the server can't reach (see fallback.js). Created once
// /api/config has said which sources may fall back, and to where.
let fallbacks = createFallbacks();
let lastSources = [];

// Health, chips and layer hints follow what the map shows: the server's data, or
// the browser's own while it stands in for a failing source.
function showStatus() {
  const shown = lastSources.map((s) => fallbacks.status(s));
  shown.forEach(noteHealth);
  for (const s of shown) byId.get(s.id)?.onStatus?.(s);
  summary.update(shown);
}

async function tick() {
  let delay = STATUS_POLL_MS;
  try {
    const { sources, serverTime } = await getJson('/api/status');
    clockOffset = serverTime - Date.now();
    if (sources.some((s) => s.loading)) delay = 1000; // first load: pick data up as soon as it lands
    lastSources = sources;
    await Promise.all(sources.map(loadSource));
    showStatus();
  } catch {
    lastSources = [];
    summary.setServerDown();
  } finally {
    setTimeout(tick, delay);
  }
}

// Reaches the map only when no marker or shape took the click (they set
// bubblingMouseEvents: false) and never for clicks on map controls.
map.on('click', (e) => {
  if (!ctx.pick(e.containerPoint)) detail.hide();
});

// Small handle for scripts/smoke.mjs and for poking around in the console.
window.__huntersEye = { map, layers, selectFirst: (id) => byId.get(id)?.focusFirst?.() ?? false };

getJson('/api/config')
  .then(({ basemap, fallback }) => {
    if (basemap) addBasemap(basemap);
    fallbacks = createFallbacks(fallback, {
      onData: (id, data) => byId.get(id)?.update(data),
      onChange: () => lastSources.length && showStatus(),
      options: (id) => byId.get(id)?.fetchOptions?.() ?? {},
    });
  })
  .catch((err) => console.warn('No browser fallback:', err.message))
  .finally(tick);
