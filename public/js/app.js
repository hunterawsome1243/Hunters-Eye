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

// Escape closes the open phone panel before anything under the scrim. It is registered
// before the detail sheet's own Escape (createDetailPanel below), so the stop here reaches it; the chip
// popover's capture-phase Escape still goes first.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !PHONE.matches || !document.body.classList.contains('sidebar-open')) return;
  e.stopImmediatePropagation();
  setSidebar(false);
});

const feed = createFeed(document.getElementById('feed'), document.getElementById('feed-count'), {
  isVisible: (entry) => {
    const layer = byId.get(entry.source);
    return !layer || (layer.visible && (layer.acceptsFeed?.(entry) ?? true));
  },
  // Aircraft feed ids carry the squawk after the icao ("aircraft:abc123:7700").
  isCurrent: (entry) => !!detail.key && (entry.id === detail.key || entry.id.startsWith(`${detail.key}:`)),
  // Ambient: the newest significant event (a strong quake, an Extreme or Severe alert,
  // an emergency squawk) ripples where it landed as its row arrives.
  onArrive: (entry) => entry.latlng && ripple(entry.latlng, entry.color, entry.radius, { arrive: true }),
});
const detail = createDetailPanel(document.getElementById('detail'), {
  onShow: ({ latlng, color, radius }) => {
    feed.refresh({ reveal: true });
    if (latlng) ripple(latlng, color, radius);
  },
  onClose: () => {
    layers.forEach((l) => l.clearSelection());
    feed.refresh();
    globe?.blockSpin('detail', false);
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

// A short pulse on the globe where the selected point sits, so a feed click shows
// where it landed (alert areas highlight their outline instead).
function ripple(latlng, color, radius, opts) {
  globe?.ripple(latlng, color, radius, opts);
}

// Sidebar: open by default on wide screens, where it pushes the globe aside. On phones
// it rides over the globe behind a scrim; a tap on the scrim or a leftward swipe closes it.
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const scrim = document.getElementById('scrim');
const PHONE = window.matchMedia('(max-width: 760px)');
let sizing = 0; // frame handle while the globe follows the panel's slide
// The globe resizes with the panel instead of snapping once the slide has ended: its
// size is re-read every frame, which keeps the centre where it was.
function followPanel() {
  cancelAnimationFrame(sizing);
  const started = performance.now();
  const follow = () => {
    map?.resize();
    sizing = performance.now() - started < 300 ? requestAnimationFrame(follow) : 0;
  };
  sizing = requestAnimationFrame(follow);
}
// On phones the open panel is modal: the map and the sheet under the scrim leave the
// tab order and the accessibility tree (the scrim already takes their taps), and the
// panel reads as a dialog.
const detailEl = document.getElementById('detail');
function setModal() {
  const modal = PHONE.matches && document.body.classList.contains('sidebar-open');
  mapEl.inert = modal;
  detailEl.inert = modal;
  if (modal) {
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    sidebar.setAttribute('aria-label', 'Side panel');
  } else {
    for (const a of ['role', 'aria-modal', 'aria-label']) sidebar.removeAttribute(a);
  }
}
function setSidebar(open) {
  if (!open && sidebar.contains(document.activeElement)) sidebarToggle.focus(); // nothing stays focused off screen
  document.body.classList.toggle('sidebar-open', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  setModal();
  followPanel();
}
setSidebar(window.innerWidth > 760);
// Crossing the phone breakpoint with the panel open slides the globe's edge too (from
// beside the panel to under it, or back) and changes whether the panel is modal.
PHONE.addEventListener('change', () => {
  setModal();
  if (document.body.classList.contains('sidebar-open')) followPanel();
});
requestAnimationFrame(() => [sidebar, scrim, mapEl].forEach((n) => n.classList.remove('no-anim'))); // no slide on load
sidebarToggle.addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));
scrim.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the panel until the close moves it
scrim.addEventListener('click', () => setSidebar(false));

// A touch swipe to the left drags the phone sidebar closed; the scrim fades with it.
// touch-action: pan-y leaves vertical gestures to the browser, so the feed still scrolls.
let swipe = null;
sidebar.addEventListener('pointerdown', (e) => {
  // Only the first finger swipes: a second one (a resting thumb) must not take over a swipe in flight.
  if (!e.isPrimary || e.pointerType !== 'touch' || !PHONE.matches || e.target.closest('input[type="range"], select')) return;
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
  const { dx, on, t } = swipe;
  const v = e.timeStamp - t > 100 ? 0 : swipe.v; // a finger that paused before lifting is not flicking
  swipe = null;
  sidebar.classList.remove('dragging');
  scrim.classList.remove('dragging');
  sidebar.style.transform = ''; // the slide carries on from here, closing or snapping back
  scrim.style.opacity = '';
  if (on && e.type !== 'pointercancel' && (dx < -sidebar.offsetWidth / 3 || (v < -0.5 && dx < -40))) setSidebar(false);
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
  showAlertTint();
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
      state: serverDown && s.via !== 'browser' ? 'server unreachable' : s.error ? 'failing' : s.updatedAt ? (s.via === 'browser' ? 'ok via browser' : 'ok') : 'loading',
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

// Health, chips and layer hints follow what the globe shows: the server's data, or
// the browser's own while it stands in for a failing source.
function showStatus() {
  const shown = lastSources.map((s) => fallbacks.status(s));
  shown.forEach(noteHealth);
  for (const s of shown) byId.get(s.id)?.onStatus?.(s);
  summary.update(shown, { serverDown });
  const d = liveStatus.update(shown, { serverDown });
  document.getElementById('connecting').classList.toggle('show', !!d.connecting);
  // The feed shows skeletons while feeds are still answering (a browser fallback that
  // is only waiting for its budget slot doesn't count), and settles once the server has
  // answered and every feed has answered: a fill after an offline start is not news.
  const answering = !!d.connecting || shown.some((s) => s.loading && !s.waiting);
  feed.setLoading(answering);
  if (shown.length && !answering) feed.settle();
  showAlertTint();
}

// Ambient: the top bar's edge carries an alert tint while an Extreme alert or an
// emergency squawk is live on a layer that is showing.
function showAlertTint() {
  document.body.classList.toggle('alert-live', layers.some((l) => l.urgent && l.visible));
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

// Small handle for scripts/smoke.mjs and for poking around in the console.
window.__huntersEye = {
  map,
  globe,
  layers,
  feed,
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
      onChange: () => (lastSources.length || serverDown) && showStatus(),
      options: (id) => byId.get(id)?.fetchOptions?.() ?? {},
    });
  })
  .catch((err) => console.warn('No browser fallback:', err.message))
  .finally(tick);
