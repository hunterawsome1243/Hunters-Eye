import { getJson } from './api.js';
import { createFallbacks } from './fallback.js';
import { createDetailPanel } from './ui/detail.js';
import { createFeed } from './ui/feed.js';
import { createStatus } from './ui/status.js';
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

// Sidebar: open by default on wide screens, where it pushes the map aside. On phones
// it rides over the map behind a scrim; a tap on the scrim or a leftward swipe closes it.
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const scrim = document.getElementById('scrim');
const PHONE = window.matchMedia('(max-width: 760px)');
let sizing = 0; // frame handle while the map follows the panel's slide
function setSidebar(open) {
  if (!open && sidebar.contains(document.activeElement)) sidebarToggle.focus(); // nothing stays focused off screen
  document.body.classList.toggle('sidebar-open', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  // The map resizes with the panel instead of snapping once the slide has ended: its
  // size is re-read every frame, which keeps the centre where it was.
  cancelAnimationFrame(sizing);
  const started = performance.now();
  const follow = () => {
    map.invalidateSize({ animate: false, debounceMoveend: true });
    sizing = performance.now() - started < 300 ? requestAnimationFrame(follow) : 0;
  };
  sizing = requestAnimationFrame(follow);
}
setSidebar(window.innerWidth > 760);
requestAnimationFrame(() => [sidebar, scrim, document.getElementById('map')].forEach((n) => n.classList.remove('no-anim'))); // no slide on load
sidebarToggle.addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));
scrim.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the panel until the close moves it
scrim.addEventListener('click', () => setSidebar(false));

// A touch swipe to the left drags the phone sidebar closed; the scrim fades with it.
// touch-action: pan-y leaves vertical gestures to the browser, so the feed still scrolls.
let swipe = null;
sidebar.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || !PHONE.matches || e.target.closest('input[type="range"], select')) return;
  swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, t: e.timeStamp, v: 0, on: false };
});
sidebar.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x;
  if (!swipe.on) {
    if (Math.abs(dx) <= 8 || Math.abs(dx) < Math.abs(e.clientY - swipe.y)) return; // not a sideways swipe yet
    swipe.on = true;
    try { sidebar.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    sidebar.classList.add('dragging');
    scrim.classList.add('dragging');
  }
  swipe.v = (Math.min(0, dx) - swipe.dx) / Math.max(1, e.timeStamp - swipe.t); // px per ms, latest movement
  swipe.t = e.timeStamp;
  swipe.dx = Math.min(0, dx);
  sidebar.style.transform = `translateX(${swipe.dx}px)`;
  scrim.style.opacity = String(1 + swipe.dx / sidebar.offsetWidth);
});
function endSwipe(e) {
  if (!swipe || e.pointerId !== swipe.id) return;
  const { dx, v, on } = swipe;
  swipe = null;
  if (!on) return;
  sidebar.classList.remove('dragging');
  scrim.classList.remove('dragging');
  sidebar.style.transform = ''; // the slide carries on from here, closing or snapping back
  scrim.style.opacity = '';
  if (e.type !== 'pointercancel' && (dx < -sidebar.offsetWidth / 3 || (v < -0.5 && dx < -40))) setSidebar(false);
}
sidebar.addEventListener('pointerup', endSwipe);
sidebar.addEventListener('pointercancel', endSwipe);

// Filters fold away under the feed; closed to start with where the sidebar is short.
const filtersSection = document.querySelector('.filters-section');
const filtersToggle = document.getElementById('filters-toggle');
function setFilters(open) {
  filtersSection.classList.toggle('open', open);
  filtersSection.classList.toggle('closed', !open);
  filtersToggle.setAttribute('aria-expanded', String(open));
}
setFilters(!window.matchMedia('(max-width: 760px), (max-height: 500px)').matches);
requestAnimationFrame(() => filtersSection.classList.remove('no-anim')); // no fold animation on load
filtersToggle.addEventListener('click', () => setFilters(filtersSection.classList.contains('closed')));

const layers = [];
const byId = new Map();
const feed = createFeed(document.getElementById('feed'), document.getElementById('feed-count'), {
  isVisible: (entry) => {
    const layer = byId.get(entry.source);
    return !layer || (map.hasLayer(layer.layer) && (layer.acceptsFeed?.(entry) ?? true));
  },
  // Aircraft feed ids carry the squawk after the icao ("aircraft:abc123:7700").
  isCurrent: (entry) => !!detail.key && (entry.id === detail.key || entry.id.startsWith(`${detail.key}:`)),
});
const detail = createDetailPanel(document.getElementById('detail'), {
  onShow: ({ latlng, color, radius }) => {
    feed.refresh({ reveal: true });
    if (latlng) ripple(latlng, color, radius);
  },
  onClose: () => {
    layers.forEach((l) => l.clearSelection());
    feed.refresh();
  },
});
const filtersEl = document.getElementById('filters');

// A short pulse on the map where the selected point sits, so a feed click shows
// where it landed (alert areas highlight their outline instead). radius is the
// marker's, so the ring starts just outside it.
function ripple(latlng, color, radius = 8) {
  const size = Math.round(radius * 2 + 8);
  const marker = L.marker(latlng, {
    icon: L.divIcon({ className: 'ripple', html: `<i style="--c:${color}"></i>`, iconSize: [size, size] }),
    interactive: false,
    keyboard: false,
  }).addTo(map);
  setTimeout(() => map.removeLayer(marker), 1500);
}

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
const liveStatus = createStatus(document.getElementById('status'), document.getElementById('banner'));

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
    kind: state,
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
let serverDown = false;

// Health, chips and layer hints follow what the map shows: the server's data, or
// the browser's own while it stands in for a failing source.
function showStatus() {
  const shown = lastSources.map((s) => fallbacks.status(s));
  shown.forEach(noteHealth);
  for (const s of shown) byId.get(s.id)?.onStatus?.(s);
  summary.update(shown, { serverDown });
  const d = liveStatus.update(shown, { serverDown });
  document.getElementById('connecting').classList.toggle('show', !!d.connecting);
  feed.setLoading(!!d.connecting || shown.some((s) => s.loading)); // until every feed has answered once
}

async function tick() {
  let delay = STATUS_POLL_MS;
  try {
    const { sources, serverTime } = await getJson('/api/status');
    clockOffset = serverTime - Date.now();
    if (sources.some((s) => s.loading)) delay = 1000; // first load: pick data up as soon as it lands
    lastSources = sources;
    serverDown = false;
    await Promise.all(sources.map(loadSource));
    showStatus();
  } catch {
    // Keep the last rows: the chips show how old their data is, and a browser
    // fallback that is still fetching keeps reporting through them.
    serverDown = true;
    showStatus();
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
window.__huntersEye = { map, layers, feed, selectFirst: (id) => byId.get(id)?.focusFirst?.() ?? false };

getJson('/api/config')
  .then(({ basemap, fallback }) => {
    if (basemap) addBasemap(basemap);
    fallbacks = createFallbacks(fallback, {
      onData: (id, data) => byId.get(id)?.update(data),
      onChange: () => (lastSources.length || serverDown) && showStatus(),
      options: (id) => byId.get(id)?.fetchOptions?.() ?? {},
    });
  })
  .catch((err) => console.warn('No browser fallback:', err.message))
  .finally(tick);
