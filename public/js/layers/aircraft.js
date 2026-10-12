import { putJson } from '../api.js';
import { EMPTY, SEL, fc, inBox, padBox } from '../globe/geo.js';
import { planeImage } from '../globe/icons.js';
import { dateTime, el, latLon, num, timeAgo } from '../ui/format.js';

const COLOR = '#38bdf8';
const MAX_EXTRAPOLATE_S = 300;
const SUBSET_ZOOM = 10; // from here up only the planes near the view are pushed to the GPU
const EMERGENCY = { '7500': 'Hijack (7500)', '7600': 'Radio failure (7600)', '7700': 'General emergency (7700)' };
export const CATEGORY = ['No info', 'No ADS-B category', 'Light', 'Small', 'Large', 'High-vortex large', 'Heavy', 'High performance',
  'Rotorcraft', 'Glider', 'Lighter than air', 'Parachutist', 'Ultralight', 'Reserved', 'UAV', 'Space vehicle',
  'Emergency vehicle', 'Service vehicle', 'Point obstacle', 'Cluster obstacle', 'Line obstacle'];

const SRC = 'he-aircraft';
const SEL_SRC = 'he-aircraft-sel';
const IMG = 'he-plane';

// The detail swatch and the feed colour; the ALT paint expression below mirrors these buckets.
export function altitudeColor(a) {
  if (a.onGround) return '#6b7280';
  const alt = a.altitude ?? 0;
  if (alt < 3000) return '#5eead4';
  if (alt < 7000) return '#38bdf8';
  if (alt < 10000) return '#a5b4fc';
  return '#e0f2fe';
}
const ALT = ['case', ['==', ['get', 'g'], 1], '#6b7280',
  ['step', ['coalesce', ['get', 'a'], 0], '#5eead4', 3000, '#38bdf8', 7000, '#a5b4fc', 10000, '#e0f2fe']];
const ICON_LAYOUT = {
  'icon-image': IMG,
  'icon-rotate': ['get', 't'],
  'icon-rotation-alignment': 'map',
  'icon-pitch-alignment': 'viewport',
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
};

// Estimated position now, from the last report plus speed along the heading.
// Age is measured on the server's clock, so a skewed browser clock doesn't matter.
// Returns [lat, lon] like the server rows; GeoJSON wants [lon, lat].
export function position(a, nowMs = Date.now(), clockOffset = 0) {
  if (a.onGround || !a.velocity || a.track == null || a.timePosition == null) return [a.lat, a.lon];
  const age = (nowMs + clockOffset) / 1000 - a.timePosition;
  const dt = Math.min(Math.max(age, 0), MAX_EXTRAPOLATE_S);
  const d = a.velocity * dt;
  const rad = (a.track * Math.PI) / 180;
  const lat = a.lat + (d * Math.cos(rad)) / 111_320;
  const lon = a.lon + (d * Math.sin(rad)) / (111_320 * Math.max(Math.cos((a.lat * Math.PI) / 180), 0.01));
  return [lat, lon];
}

// One small feature per plane: thousands of them cross the worker boundary on every push.
export function planeFeature(a, lat, lon) {
  return {
    type: 'Feature',
    id: a.icao24,
    properties: { icao24: a.icao24, t: a.track ?? 0, a: a.altitude, g: a.onGround ? 1 : 0, em: EMERGENCY[a.squawk] ? 1 : 0 },
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}

// Dead-reckoning cadence in ms by zoom (0 = none: movement is sub-pixel from space).
export function intervalFor(zoom, phone = false) {
  const ms = zoom < 3 ? 0 : zoom < 6 ? 12_000 : zoom < SUBSET_ZOOM ? 5000 : zoom < 13 ? 2000 : 1000;
  return phone ? ms * 2 : ms;
}

export default function create(ctx) {
  const { map, feed, detail } = ctx;
  let aircraft = []; // objects built from the server's compact rows
  let byIcao = new Map();
  let selected = null;
  let onlyInView = false;
  let last = EMPTY; // what the he-aircraft source holds
  let selData = EMPTY; // what the he-aircraft-sel source holds
  let subset = null; // the padded box the current push was limited to, or null for the whole world
  let inViewCount = 0;
  let hasCountLayer = false;

  const pos = (a, now = Date.now()) => position(a, now, ctx.clockOffset());
  const zoom = () => map?.getZoom() ?? 0;
  const canSet = (layerId) => ctx.ready() && !!map?.getLayer(layerId);

  // --- style ----------------------------------------------------------------------
  function mount() {
    ctx.addSource(SRC, { type: 'geojson', promoteId: 'icao24', data: last, cluster: true, clusterRadius: 36, clusterMaxZoom: 4, maxzoom: 12, buffer: 16, tolerance: 1 });
    ctx.addSource(SEL_SRC, { type: 'geojson', promoteId: 'icao24', data: selData });
    ctx.addImage(IMG, planeImage(), { sdf: true, pixelRatio: 2 });
    ctx.addLayer({
      id: 'he-aircraft-cluster', type: 'circle', source: SRC, filter: ['has', 'point_count'],
      paint: {
        'circle-color': COLOR, 'circle-opacity': 0.45, 'circle-blur': 0.3,
        'circle-stroke-color': COLOR, 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.6,
        'circle-radius': ['step', ['get', 'point_count'], 8, 50, 11, 200, 15, 1000, 20],
        'circle-pitch-alignment': 'viewport',
      },
    }, 'planes');
    ctx.addLayer({
      id: 'he-aircraft', type: 'symbol', source: SRC, filter: ['!', ['has', 'point_count']],
      layout: { ...ICON_LAYOUT, 'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.75, 7, 1, 10, 1.25] },
      paint: {
        'icon-color': ['case', SEL, '#fde047', ALT],
        'icon-halo-color': '#f87171',
        'icon-halo-width': ['*', 1.5, ['get', 'em']],
        'icon-opacity': 0.95,
      },
    }, 'planes');
    hasCountLayer = ctx.hasGlyphs();
    if (hasCountLayer) {
      ctx.addLayer({
        id: 'he-aircraft-count', type: 'symbol', source: SRC, filter: ['all', ['has', 'point_count'], ['>=', ['get', 'point_count'], 50]],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': '#e8eef5', 'text-halo-color': '#0a0d12', 'text-halo-width': 1 },
      }, 'labels');
    }
    ctx.addLayer({
      id: 'he-aircraft-sel-ring', type: 'circle', source: SEL_SRC,
      paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'viewport' },
    }, 'top');
    ctx.addLayer({
      id: 'he-aircraft-sel-icon', type: 'symbol', source: SEL_SRC,
      layout: { ...ICON_LAYOUT, 'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 1.125, 7, 1.5, 10, 1.875] },
      paint: { 'icon-color': '#fde047' },
    }, 'top');
    api.layerIds = hasCountLayer
      ? ['he-aircraft-cluster', 'he-aircraft', 'he-aircraft-count', 'he-aircraft-sel-ring', 'he-aircraft-sel-icon']
      : ['he-aircraft-cluster', 'he-aircraft', 'he-aircraft-sel-ring', 'he-aircraft-sel-icon'];
    // The sources may have survived from before (ctx.addSource is a no-op then): re-push.
    map.getSource(SRC)?.setData(last);
    map.getSource(SEL_SRC)?.setData(selData);
    applySelectionState(selected, true);
  }

  // Feature state does not survive a style swap; mount() calls this again.
  function applySelectionState(icao, on) {
    if (!icao || !canSet('he-aircraft')) return;
    if (on) map.setFeatureState({ source: SRC, id: icao }, { selected: true });
    else map.removeFeatureState({ source: SRC, id: icao });
  }

  // --- data ---------------------------------------------------------------------------
  // Rebuild the collection from dead-reckoned positions and push it. Close in, only
  // the planes around the view (plus the selected one) go to the GPU.
  function render() {
    const now = Date.now();
    const vb = ctx.viewBounds();
    const box = zoom() >= SUBSET_ZOOM && vb ? padBox(vb, 0.5) : null;
    const countBox = onlyInView && vb ? padBox(vb, 0.05) : null;
    const features = [];
    let n = 0;
    for (const a of aircraft) {
      const [lat, lon] = pos(a, now);
      if (!countBox || inBox(countBox, lat, lon)) n++;
      if (!box || a.icao24 === selected || inBox(box, lat, lon)) features.push(planeFeature(a, lat, lon));
    }
    inViewCount = n;
    last = fc(features);
    subset = box;
    map?.getSource(SRC)?.setData(last);
    pushSelected(now);
  }

  function pushSelected(now = Date.now()) {
    const a = selected ? byIcao.get(selected) : null;
    selData = a ? fc([planeFeature(a, ...pos(a, now))]) : EMPTY;
    map?.getSource(SEL_SRC)?.setData(selData);
  }

  function recount() {
    const vb = ctx.viewBounds();
    const countBox = onlyInView && vb ? padBox(vb, 0.05) : null;
    inViewCount = countBox ? aircraft.filter((a) => inBox(countBox, ...pos(a))).length : aircraft.length;
  }

  function showDetail(a) {
    const [lat, lon] = pos(a);
    const ft = a.altitude != null ? ` (${num(a.altitude * 3.28084)} ft)` : '';
    detail.show({
      key: `aircraft:${a.icao24}`,
      color: altitudeColor(a),
      kind: 'Aircraft',
      heading: a.callsign || a.icao24.toUpperCase(),
      fields: [
        ['Callsign', a.callsign || '—'],
        ['ICAO 24-bit', a.icao24.toUpperCase()],
        ['Registered in', a.country],
        ['Altitude', a.onGround ? 'On ground' : a.altitude != null ? `${num(a.altitude)} m${ft}` : '—'],
        ['Ground speed', a.velocity != null ? `${num(a.velocity * 3.6)} km/h (${num(a.velocity * 1.94384)} kt)` : '—'],
        ['Heading', a.track != null ? `${num(a.track)}°` : '—'],
        ['Vertical rate', a.verticalRate != null ? `${a.verticalRate > 0 ? '+' : ''}${num(a.verticalRate, 1)} m/s` : null],
        ['Squawk', a.squawk ? `${a.squawk}${EMERGENCY[a.squawk] ? ` · ${EMERGENCY[a.squawk]}` : ''}` : null],
        ['Category', a.category > 1 ? CATEGORY[a.category] : null],
        ['Position', latLon(lat, lon)],
        ['Last report', a.lastContact ? `${dateTime(a.lastContact * 1000)} (${timeAgo(a.lastContact * 1000)})` : '—'],
      ],
      notes: a.onGround || !a.velocity ? '' : 'Position is estimated from the last report using speed and heading.',
      link: { href: `https://globe.adsbexchange.com/?icao=${a.icao24}`, label: 'Track on ADS-B Exchange ↗' },
    });
  }

  function select(icao) {
    const a = byIcao.get(icao);
    if (!a) return;
    if (selected && selected !== icao) applySelectionState(selected, false);
    selected = icao;
    applySelectionState(icao, true);
    ctx.select(api);
    showDetail(a);
    pushSelected();
  }

  function focus(icao) {
    const a = byIcao.get(icao);
    if (!a || !api.visible) return;
    if (selected && selected !== icao) applySelectionState(selected, false);
    selected = icao; // so a close-in subset push includes it
    render(); // the icon sits exactly where the camera lands
    // Select before flying: ctx.select() pauses the spin with map.stop(), which
    // would cancel a flight already under way.
    select(icao);
    const [lat, lon] = pos(a);
    ctx.flyTo({ center: [lon, lat], minZoom: 7 });
  }

  function update(data) {
    const f = data.fields;
    aircraft = data.states.map((row) => Object.fromEntries(f.map((k, i) => [k, row[i]])));
    byIcao = new Map(aircraft.map((a) => [a.icao24, a]));
    for (const a of aircraft) {
      if (!EMERGENCY[a.squawk]) continue;
      feed.add({
        id: `aircraft:${a.icao24}:${a.squawk}`,
        source: 'aircraft',
        time: (a.lastContact ?? data.time / 1000) * 1000,
        color: '#f87171',
        title: `${a.callsign || a.icao24.toUpperCase()} squawking ${a.squawk}`,
        subtitle: `${EMERGENCY[a.squawk].replace(/ \(\d+\)/, '')} · ${a.country} · ${a.onGround ? 'on ground' : `${num(a.altitude)} m`}`,
        onClick: () => focus(a.icao24),
      });
    }
    if (selected && !byIcao.has(selected)) {
      // The plane left the data (out of the view box, or dropped by OpenSky).
      const gone = selected;
      applySelectionState(gone, false);
      selected = null;
      if (detail.key === `aircraft:${gone}`) detail.hide();
    } else if (selected && detail.key === `aircraft:${selected}`) {
      showDetail(byIcao.get(selected));
    }
    render();
  }

  // --- timers ---------------------------------------------------------------------------
  // Dead reckoning between refreshes: the interval follows the zoom (section 7), and the
  // timer re-arms itself so a zoom change takes effect at the next run.
  let reckonTimer = null;
  function armReckoning() {
    clearTimeout(reckonTimer);
    const ms = intervalFor(zoom(), ctx.phone());
    reckonTimer = setTimeout(reckon, ms || 12_000);
  }
  function reckon() {
    const ms = intervalFor(zoom(), ctx.phone());
    if (ms && !document.hidden && api.visible && aircraft.length && !map?.isMoving()) render();
    armReckoning();
  }
  armReckoning();

  // The selected plane: ring, big icon and detail refreshed every 2 s.
  setInterval(() => {
    if (document.hidden || !api.visible || !selected || !byIcao.has(selected)) return;
    if (detail.key === `aircraft:${selected}`) showDetail(byIcao.get(selected));
    pushSelected();
  }, 2000);

  // --- filter: only fetch and count aircraft in the current view -----------------------------
  const hint = el('div', { class: 'hint' }, 'Covers the whole world.');
  const checkbox = el('input', { type: 'checkbox' });
  const filter = el('div', { class: 'filter' }, el('label', {}, 'Only aircraft in current view', checkbox), hint);
  ctx.addFilter(filter);

  // null = more than a hemisphere on screen: the server and the fallback treat it as "no box".
  const viewBox = () => ctx.viewBounds();
  let sendTimer = null;
  function sendView() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      putJson('/api/sources/aircraft/options', { bbox: onlyInView ? viewBox() : null }).catch((err) => console.warn('aircraft options:', err.message));
    }, 800);
  }
  checkbox.addEventListener('change', () => {
    onlyInView = checkbox.checked;
    ctx.blockSpin('aircraft-view', onlyInView); // the spin would refetch on every step
    sendView();
    recount();
    ctx.feed.refresh();
  });
  // After a move (not the spin's own steps): refetch for the view filter, and re-push
  // when a close-in subset no longer covers the view or the view zoomed back out.
  ctx.onView(() => {
    if (onlyInView) sendView();
    const vb = ctx.viewBounds();
    const z = zoom();
    if (subset && (z < SUBSET_ZOOM || !vb || !boxInside(vb, subset))) render();
    else if (!subset && z >= SUBSET_ZOOM && vb && aircraft.length) render();
    else recount();
  });
  // Tell the server our setting on load (a previous page may have left a box set),
  // then keep the box alive while the filter is on; the server drops stale ones.
  sendView();
  setInterval(() => {
    if (onlyInView) sendView();
  }, 4 * 60_000);

  const api = {
    id: 'aircraft',
    name: 'Aircraft',
    source: 'OpenSky Network',
    color: COLOR,
    visible: true,
    layerIds: ['he-aircraft-cluster', 'he-aircraft', 'he-aircraft-sel-ring', 'he-aircraft-sel-icon'],
    interactive: [
      { layer: 'he-aircraft', priority: 30 },
      { layer: 'he-aircraft-cluster', priority: 30 },
      { layer: 'he-aircraft-sel-icon', priority: 35 },
    ],
    mount,
    update,
    pick(f) {
      if (f.layer.id === 'he-aircraft-cluster') {
        const id = f.properties.cluster_id;
        map.getSource(SRC)?.getClusterExpansionZoom(id)
          .then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: Math.max(z, 5.1), duration: 600 }))
          .catch((err) => console.warn('aircraft cluster:', err.message));
        return true;
      }
      const icao = f.id ?? f.properties?.icao24 ?? selected;
      if (!icao || !byIcao.has(icao)) return false;
      select(icao);
      return true;
    },
    onShow() {
      armReckoning();
      if (aircraft.length) render();
    },
    onHide() {
      clearTimeout(reckonTimer);
    },
    count: () => (onlyInView ? inViewCount : aircraft.length),
    fetchOptions: () => ({ bbox: onlyInView ? viewBox() : null }),
    onStatus(s) {
      const every = s.intervalMs >= 60_000 ? `${Math.round(s.intervalMs / 60_000)} min` : `${Math.round(s.intervalMs / 1000)} s`;
      hint.textContent = `${s.note ? `${s.note.split('.')[0]}.` : ''} Refreshes every ${every}${onlyInView ? '; a smaller view refreshes faster' : ''}.`.trim();
    },
    acceptsFeed(entry) {
      if (!onlyInView) return true;
      const a = byIcao.get(entry.id.split(':')[1]);
      if (!a) return false;
      const vb = viewBox();
      return inBox(vb ? padBox(vb, 0.1) : null, ...pos(a));
    },
    focusFirst() {
      const a = aircraft.find((x) => !x.onGround && x.velocity) || aircraft[0];
      if (a) focus(a.icao24);
      return !!a;
    },
    clearSelection() {
      if (selected === null) return;
      applySelectionState(selected, false);
      selected = null;
      pushSelected();
    },
  };
  return api;
}

// Is box a inside box b (both { lamin, lomin, lamax, lomax }, longitudes around the same centre)?
export function boxInside(a, b) {
  return a.lamin >= b.lamin && a.lamax <= b.lamax && a.lomin >= b.lomin && a.lomax <= b.lomax;
}
