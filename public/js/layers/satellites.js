import { dateTime, el, latLon, num, timeAgo } from '../ui/format.js';
import { EMPTY, SEL, fc, footprintRadiusKm, geodesicCircle, recentre, unwrapLine } from '../globe/geo.js';

const COLOR = '#a78bfa';
const TICK_MS = 1000;
const TRACK_STEP_S = 30;
const TRACK_REFRESH_MS = 60_000;
const DEFAULT_TRACKED = '25544'; // ISS

// Style ids. Bottom to top: footprint, tracks, dots, labels.
const SRC = 'he-satellites';
const SRC_TRACK = 'he-satellites-track';
const SRC_FOOT = 'he-satellites-footprint';
const L_FOOT_FILL = 'he-satellites-footprint-fill';
const L_FOOT_LINE = 'he-satellites-footprint-line';
const L_TRACK_PAST = 'he-satellites-track-past';
const L_TRACK_NEXT = 'he-satellites-track-next';
const L_DOTS = 'he-satellites';
const L_LABEL = 'he-satellites-label';

// Sub-satellite point, altitude and speed at a given time, or null if SGP4 fails
// (for example an object whose elements are too old to propagate).
export function locate(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv?.position || !pv.velocity) return null;
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
  const { x, y, z } = pv.velocity;
  return {
    lat: satellite.degreesLat(geo.latitude),
    lon: satellite.degreesLong(geo.longitude),
    alt: geo.height,
    speed: Math.sqrt(x * x + y * y + z * z),
  };
}

// The ground track between two times as one continuous [lon, lat] line: the
// longitudes are unwrapped (no step over 180°) and recentred, so MapLibre draws
// it across the antimeridian instead of in split pieces. null when too short.
export function trackLine(satrec, fromMs, toMs, step = TRACK_STEP_S * 1000) {
  const pts = [];
  for (let t = fromMs; t <= toMs; t += step) {
    const p = locate(satrec, new Date(t));
    if (p) pts.push([p.lon, p.lat]);
  }
  return pts.length > 1 ? recentre(unwrapLine(pts)) : null;
}

export function epochDate(satrec) {
  const year = satrec.epochyr < 57 ? 2000 + satrec.epochyr : 1900 + satrec.epochyr;
  return Date.UTC(year, 0, 1) + (satrec.epochdays - 1) * 86_400_000;
}

// The GeoJSON feature for one satellite with a known position. `n` marks the
// notable ones (bigger dot, label); the selected satellite is matched by `id`.
export function satFeature(sat, pos) {
  return {
    type: 'Feature',
    id: sat.id,
    properties: { id: sat.id, n: sat.notable ? 1 : 0, ...(sat.notable && { label: sat.notable }) },
    geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
  };
}

// The dots layer's filter: everything, or only notables plus the selected one.
export function notableFilter(notableOnly, selected) {
  return notableOnly ? ['any', ['==', ['get', 'n'], 1], ['==', ['get', 'id'], selected ?? '']] : null;
}

export default function create(ctx) {
  const { map, feed, detail } = ctx;
  const sats = new Map(); // id -> { sat, satrec, pos }
  let selected = null;
  let tracked = DEFAULT_TRACKED;
  let notableOnly = false;
  let trackDrawnAt = 0;
  let lastSats = EMPTY; // cached GeoJSON, re-pushed by mount() after a style load
  let lastTrack = EMPTY;
  let lastFoot = EMPTY;
  let timer = null;

  const filterBox = el('input', { type: 'checkbox' });
  ctx.addFilter(el('div', { class: 'filter' },
    el('label', {}, 'Only notable satellites', filterBox),
    el('div', { class: 'hint' }, 'Labels: ISS, Tiangong, Hubble and a few more. The track follows the selected one.')));
  filterBox.addEventListener('change', () => {
    notableOnly = filterBox.checked;
    applyFilter();
  });

  // --- style state (filter, selection) --------------------------------------
  // setFilter and feature state throw while a style loads; mount() re-applies
  // them once the style is ready.
  const styleReady = (layerId) => ctx.ready() && !!map?.getLayer(layerId);

  function applyFilter() {
    if (!styleReady(L_DOTS)) return;
    map.setFilter(L_DOTS, notableFilter(notableOnly, selected));
  }

  function setSelectedState(id, on) {
    if (id == null || !ctx.ready() || !map?.getSource(SRC)) return;
    if (on) map.setFeatureState({ source: SRC, id }, { selected: true });
    else map.removeFeatureState({ source: SRC, id }, 'selected');
  }

  function mount() {
    ctx.addSource(SRC, { type: 'geojson', promoteId: 'id', data: lastSats, maxzoom: 8, buffer: 16 });
    ctx.addSource(SRC_TRACK, { type: 'geojson', data: lastTrack, maxzoom: 6, buffer: 32, tolerance: 1 });
    ctx.addSource(SRC_FOOT, { type: 'geojson', data: lastFoot, maxzoom: 6 });
    ctx.addLayer({ id: L_FOOT_FILL, type: 'fill', source: SRC_FOOT, paint: { 'fill-color': COLOR, 'fill-opacity': 0.06 } }, 'tracks');
    ctx.addLayer({ id: L_FOOT_LINE, type: 'line', source: SRC_FOOT, paint: { 'line-color': COLOR, 'line-width': 1, 'line-opacity': 0.5 } }, 'tracks');
    // line-dasharray can't vary per feature, so past and next are two layers.
    ctx.addLayer({
      id: L_TRACK_PAST, type: 'line', source: SRC_TRACK, filter: ['==', ['get', 'phase'], 'past'],
      paint: { 'line-color': COLOR, 'line-width': 1.5, 'line-opacity': 0.45, 'line-dasharray': [2.67, 4] },
    }, 'tracks');
    ctx.addLayer({
      id: L_TRACK_NEXT, type: 'line', source: SRC_TRACK, filter: ['==', ['get', 'phase'], 'next'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.75, 8, 3], 'line-opacity': 0.85 },
    }, 'tracks');
    const filter = notableFilter(notableOnly, selected);
    ctx.addLayer({
      id: L_DOTS, type: 'circle', source: SRC, ...(filter && { filter }),
      paint: {
        'circle-radius': ['case', ['==', ['get', 'n'], 1], 6, 3.5],
        'circle-color': COLOR,
        'circle-opacity': ['case', ['==', ['get', 'n'], 1], 0.9, 0.6],
        'circle-stroke-color': ['case', SEL, '#ffffff', COLOR],
        'circle-stroke-width': ['case', SEL, 2.5, 1],
        'circle-pitch-alignment': 'viewport',
      },
    }, 'points');
    if (ctx.hasGlyphs()) {
      ctx.addLayer({
        id: L_LABEL, type: 'symbol', source: SRC, filter: ['has', 'label'],
        layout: {
          'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
          'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-allow-overlap': true, 'text-ignore-placement': true,
        },
        paint: { 'text-color': '#ddd6fe', 'text-halo-color': '#000000', 'text-halo-width': 1.2 },
      }, 'labels');
    }
    map.getSource(SRC)?.setData(lastSats);
    map.getSource(SRC_TRACK)?.setData(lastTrack);
    map.getSource(SRC_FOOT)?.setData(lastFoot);
    applyFilter();
    setSelectedState(selected, true);
  }

  // --- drawing ------------------------------------------------------------------
  function pushDots() {
    const features = [];
    for (const s of sats.values()) if (s.pos) features.push(satFeature(s.sat, s.pos));
    lastSats = fc(features);
    map?.getSource(SRC)?.setData(lastSats);
  }

  function pushFootprint() {
    const s = sats.get(tracked);
    lastFoot = s?.pos
      ? fc([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [geodesicCircle(s.pos.lon, s.pos.lat, footprintRadiusKm(s.pos.alt))] } }])
      : EMPTY;
    map?.getSource(SRC_FOOT)?.setData(lastFoot);
  }

  function drawTrack() {
    const s = sats.get(tracked);
    trackDrawnAt = Date.now();
    if (!s?.pos) {
      lastTrack = EMPTY;
    } else {
      const periodMs = ((2 * Math.PI) / s.satrec.no) * 60_000;
      const now = Date.now();
      lastTrack = fc([
        { type: 'Feature', properties: { phase: 'past' }, geometry: { type: 'LineString', coordinates: trackLine(s.satrec, now - periodMs / 2, now) } },
        { type: 'Feature', properties: { phase: 'next' }, geometry: { type: 'LineString', coordinates: trackLine(s.satrec, now, now + periodMs) } },
      ].filter((f) => f.geometry.coordinates));
    }
    map?.getSource(SRC_TRACK)?.setData(lastTrack);
    pushFootprint();
  }

  function showDetail(s) {
    const { sat, satrec, pos } = s;
    const periodMin = (2 * Math.PI) / satrec.no;
    const epoch = epochDate(satrec);
    detail.show({
      key: `satellites:${sat.id}`,
      color: COLOR,
      kind: 'Satellite',
      heading: sat.notable && !sat.name.includes(sat.notable) ? `${sat.notable} · ${sat.name}` : sat.name,
      fields: [
        ['NORAD ID', sat.id],
        ['Altitude', pos ? `${num(pos.alt)} km` : '—'],
        ['Speed', pos ? `${num(pos.speed, 2)} km/s` : '—', pos ? `${num(pos.speed * 3600)} km/h` : null],
        ['Position', pos ? latLon(pos.lat, pos.lon) : '—'],
        ['Inclination', `${num((satrec.inclo * 180) / Math.PI, 2)}°`],
        ['Orbital period', `${num(periodMin, 1)} min`],
        ['Element set epoch', dateTime(epoch), timeAgo(epoch)],
        ['CelesTrak group', sat.group.toLowerCase()],
      ],
      notes: 'Dashed line: last half orbit. Solid line: next full orbit. Circle: area from which it is above the horizon.',
      link: { href: `https://www.n2yo.com/satellite/?s=${encodeURIComponent(sat.id)}`, label: 'Pass predictions on N2YO ↗' },
      latlng: pos ? [pos.lat, pos.lon] : null,
      radius: sat.notable ? 6 : 3.5,
    });
  }

  function select(id) {
    const s = sats.get(id);
    if (!s) return;
    const prev = selected;
    selected = id;
    tracked = id;
    ctx.select(api);
    if (prev !== null && prev !== id) setSelectedState(prev, false);
    setSelectedState(id, true);
    applyFilter(); // a selected non-notable stays visible under the notable filter
    drawTrack();
    showDetail(s);
  }

  function focus(id) {
    const s = sats.get(id);
    if (!s?.pos || !api.visible) return;
    // Select first: ctx.select() pauses the spin with map.stop(), which would
    // cancel a flight already under way.
    select(id);
    ctx.flyTo({ center: [s.pos.lon, s.pos.lat], minZoom: 3, maxZoom: 4 });
  }

  function tick() {
    const now = new Date();
    for (const s of sats.values()) s.pos = locate(s.satrec, now);
    pushDots();
    if (Date.now() - trackDrawnAt > TRACK_REFRESH_MS) drawTrack();
    else pushFootprint();
    if (selected && sats.has(selected) && detail.key === `satellites:${selected}`) showDetail(sats.get(selected));
  }

  function update({ satellites, fetchedAt }) {
    const ids = new Set(satellites.map((s) => s.id));
    for (const [id] of sats) {
      if (ids.has(id)) continue;
      sats.delete(id);
      if (id === selected) {
        setSelectedState(id, false);
        selected = null;
        if (detail.key === `satellites:${id}`) detail.hide();
      }
      if (id === tracked) tracked = DEFAULT_TRACKED;
    }
    for (const sat of satellites) {
      const satrec = satellite.twoline2satrec(sat.line1, sat.line2);
      if (satrec.error) continue;
      const existing = sats.get(sat.id);
      if (existing) Object.assign(existing, { sat, satrec });
      else sats.set(sat.id, { sat, satrec, pos: null });
    }
    tick();
    drawTrack();
    feed.add({
      id: `satellites:elements:${fetchedAt}`,
      source: 'satellites',
      time: fetchedAt,
      color: COLOR,
      title: `Orbital elements for ${sats.size} satellites`,
      subtitle: 'CelesTrak: space stations and the brightest objects. Click to find the ISS.',
      onClick: () => focus(DEFAULT_TRACKED),
    });
  }

  // --- timer ----------------------------------------------------------------------
  // Dots and footprint move every second (two on phones); the track is redrawn
  // every minute from tick(). Nothing runs while the tab is hidden or the layer off.
  function startTimer() {
    if (timer) return;
    timer = setInterval(() => {
      if (document.hidden || !api.visible || !sats.size) return;
      tick();
    }, ctx.phone() ? TICK_MS * 2 : TICK_MS);
  }
  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && api.visible && sats.size) tick();
  });

  const api = {
    id: 'satellites',
    name: 'Satellites',
    source: 'CelesTrak',
    color: COLOR,
    visible: true,
    layerIds: [L_FOOT_FILL, L_FOOT_LINE, L_TRACK_PAST, L_TRACK_NEXT, L_DOTS, L_LABEL],
    interactive: [{ layer: L_DOTS, priority: 40 }],
    mount,
    update,
    count: () => [...sats.values()].filter((s) => s.pos && (!notableOnly || s.sat.notable)).length,
    focusFirst() {
      const id = sats.has(DEFAULT_TRACKED) ? DEFAULT_TRACKED : sats.keys().next().value;
      if (id) focus(id);
      return !!id;
    },
    pick(feature) {
      const id = feature.id ?? feature.properties?.id;
      if (id == null || !sats.has(String(id))) return false;
      select(String(id));
      return true;
    },
    clearSelection() {
      if (selected === null) return;
      setSelectedState(selected, false);
      selected = null;
      tracked = DEFAULT_TRACKED;
      applyFilter();
      drawTrack();
    },
    onShow() {
      startTimer();
      if (sats.size) {
        tick();
        drawTrack();
      }
    },
    onHide: stopTimer,
  };
  startTimer();
  return api;
}
