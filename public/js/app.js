import { getJson } from './api.js';
import { createFallbacks } from './fallback.js';
import { createGlobe } from './globe.js';
import { createBrief } from './ui/brief.js';
import { createDetailPanel } from './ui/detail.js';
import { createFeed } from './ui/feed.js';
import { createStatus } from './ui/status.js';
import { createSummary } from './ui/summary.js';
import { DRAW_ORDER, layerModules } from './layers/index.js';

const STATUS_POLL_MS = 5000;

const phone = () => matchMedia('(max-width: 760px), (max-height: 500px)').matches || matchMedia('(pointer: coarse)').matches;

const layers = [];
const byId = new Map();
const detail = createDetailPanel(document.getElementById('detail'), {
  onClose: () => {
    layers.forEach((l) => l.clearSelection());
    globe?.blockSpin('detail', false);
  },
});
const feed = createFeed(document.getElementById('feed'), document.getElementById('feed-count'), {
  isVisible: (entry) => {
    const layer = byId.get(entry.source);
    return !layer || (layer.visible && (layer.acceptsFeed?.(entry) ?? true));
  },
});
const filtersEl = document.getElementById('filters');
const mapEl = document.getElementById('map');

// The globe. Without WebGL2 it can't be drawn; the feed and status still run.
let globe = null;
try {
  globe = createGlobe(mapEl, { phone: phone(), detail, feed });
} catch (err) {
  console.warn('Globe unavailable:', err.message);
  const msg = document.createElement('div');
  msg.className = 'map-unsupported';
  msg.textContent = "This browser can't draw the globe; the feed and status still update.";
  mapEl.append(msg);
}
const map = globe?.map;

// Sidebar: open by default on wide screens.
const sidebarToggle = document.getElementById('sidebar-toggle');
function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  setTimeout(() => map?.resize(), 210); // just after the panel's 200ms slide
}
setSidebar(window.innerWidth > 760);
sidebarToggle.addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));

let clockOffset = 0; // server clock minus browser clock, from /api/status

// What every layer module gets. Style edits go through the idempotent add*
// helpers so a module's mount() can run again after each basemap load.
const noMap = () => {};
const ctx = {
  map,
  globe,
  addSource: globe ? globe.addSource : noMap,
  addLayer: globe ? globe.addLayer : noMap,
  addImage: globe ? globe.addImage : noMap,
  hasGlyphs: globe ? globe.hasGlyphs : () => false,
  ready: () => !!globe?.ready,
  blockSpin: (key, on) => globe?.blockSpin(key, on),
  phone,
  isVisible: (id) => !!byId.get(id)?.visible,
  clockOffset: () => clockOffset,
  feed,
  detail,
  addFilter: (node) => filtersEl.append(node),
  select(owner) {
    for (const l of layers) if (l !== owner) l.clearSelection();
    globe?.blockSpin('detail', true);
    if (window.innerWidth <= 760) setSidebar(false);
  },
  viewBounds: () => globe?.viewBounds() ?? null,
  contains: (lon, lat) => globe?.contains(lon, lat) ?? true,
  onView: (fn) => globe?.onView(fn),
  flyTo: (opts) => globe?.flyTo(opts),
  fitBounds: (bounds, opts) => globe?.fitBounds(bounds, opts),
};

for (const create of layerModules) {
  const layer = create(ctx);
  layers.push(layer);
  byId.set(layer.id, layer);
}

function applyVisibility(layer) {
  if (!globe?.ready) return; // mount() will apply it after the style loads
  for (const id of layer.layerIds) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', layer.visible ? 'visible' : 'none');
  }
}
const interactiveList = () => layers.filter((l) => l.visible).flatMap((l) => l.interactive.map((i) => ({ ...i, owner: l })));

// After every style load (the start style, then the real basemap) the data
// layers are mounted again, bottom tier first.
globe?.onStyle(() => {
  for (const id of DRAW_ORDER) byId.get(id)?.mount();
  for (const l of layers) applyVisibility(l);
  globe.setInteractive(interactiveList());
});

function setLayerVisible(layer, on) {
  layer.visible = on;
  applyVisibility(layer);
  globe?.setInteractive(interactiveList());
  if (on) {
    layer.onShow?.();
  } else {
    layer.onHide?.();
    layer.clearSelection();
    if (detail.key?.startsWith(`${layer.id}:`)) detail.hide();
  }
  feed.refresh();
  summary.render();
}

const summary = createSummary(document.getElementById('summary'), layers, { onToggle: setLayerVisible });
const liveStatus = createStatus(document.getElementById('status'), document.getElementById('banner'));

// What the "Brief me" button sends: counts, feed health and the latest events a
// reader can see, never the raw data. Shown only when the server has a key.
const brief = createBrief(document.getElementById('brief'), {
  snapshot: () => ({
    now: new Date().toISOString(),
    zoom: map ? Math.round(map.getZoom() * 10) / 10 : null,
    view: globe?.viewBounds() ?? null,
    layers: layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, count: l.count() })),
    feeds: lastSources.map((s) => fallbacks.status(s)).map((s) => ({
      id: s.id,
      state: s.error ? 'failing' : s.updatedAt ? (s.via === 'browser' ? 'ok via browser' : 'ok') : 'loading',
      detail: String(s.error || s.note || '').slice(0, 160),
    })),
    events: feed.visible(40).map((e) => ({ source: e.source, time: new Date(e.time).toISOString(), title: String(e.title ?? '').slice(0, 160), subtitle: String(e.subtitle ?? '').slice(0, 200) })),
  }),
});

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
  liveStatus.update(shown);
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
    liveStatus.setServerDown();
  } finally {
    setTimeout(tick, delay);
  }
}

// Small handle for scripts/smoke.mjs and for poking around in the console.
window.__huntersEye = {
  map,
  globe,
  layers,
  selectFirst: (id) => byId.get(id)?.focusFirst?.() ?? false,
  spin: (on) => globe?.spin.set(on),
  brief,
};

getJson('/api/config')
  .then(({ basemap, imagery, fallback, brief: briefConfig }) => {
    if (basemap) globe?.loadBasemap(basemap, imagery);
    brief.configure(briefConfig);
    fallbacks = createFallbacks(fallback, {
      onData: (id, data) => byId.get(id)?.update(data),
      onChange: () => lastSources.length && showStatus(),
      options: (id) => byId.get(id)?.fetchOptions?.() ?? {},
    });
  })
  .catch((err) => console.warn('No browser fallback:', err.message))
  .finally(tick);
