import { dateTime, el, latLon, num, timeAgo } from '../ui/format.js';
import { legend } from '../ui/legend.js';
import { EMPTY, SEL, fc } from '../globe/geo.js';

const HOUR = 3_600_000;
// Colour and fill opacity by age: at marker size the fill carries the ramp, so a
// fresh quake is a solid amber disc and an old one a faint ring.
const AGE_COLORS = [
  [HOUR, '#ffcc4d', 'past hour', 0.8],
  [6 * HOUR, '#f5a524', 'past 6 hours', 0.55],
  [24 * HOUR, '#c47f1f', 'past day', 0.35],
  [Infinity, '#8a7a66', 'older', 0.3],
];

// Index into AGE_COLORS: 0 = past hour, 1 = past 6 hours, 2 = past day, 3 = older.
export const ageBucket = (time, now = Date.now()) => AGE_COLORS.findIndex(([max]) => now - time < max);
export const ageColor = (time, now = Date.now()) => AGE_COLORS[ageBucket(time, now)][1];
export const ageFillOpacity = (time, now = Date.now()) => AGE_COLORS[ageBucket(time, now)][3];
export const radiusFor = (mag) => 2.5 + Math.max(0, mag ?? 0) ** 2 * 0.5;

// Paint expressions: the circle colour follows the `age` bucket of the feature
// (same hexes as ageColor), the stroke turns white while the feature is selected.
export const AGE = ['match', ['get', 'age'], 0, AGE_COLORS[0][1], 1, AGE_COLORS[1][1], 2, AGE_COLORS[2][1], AGE_COLORS[3][1]];
// Fill opacity by age bucket: a fresh quake is a solid disc, an old one a faint ring.
export const AGE_OPACITY = ['match', ['get', 'age'], 0, AGE_COLORS[0][3], 1, AGE_COLORS[1][3], 2, AGE_COLORS[2][3], AGE_COLORS[3][3]];
export const magFilter = (minMag) => ['>=', ['coalesce', ['get', 'mag'], -99], minMag];
export const haloFilter = (minMag) => ['all', ['==', ['get', 'age'], 0], magFilter(minMag)];

// One GeoJSON feature per quake; the id is promoted so feature state (selection) and
// click hits can address it.
export function quakeFeature(q, now = Date.now()) {
  return {
    type: 'Feature',
    id: q.id,
    properties: { id: q.id, mag: q.mag, r: radiusFor(q.mag), age: ageBucket(q.time, now) },
    geometry: { type: 'Point', coordinates: [q.lon, q.lat] },
  };
}

const SRC = 'he-earthquakes';
const HALO = 'he-earthquakes-halo';
const DOTS = 'he-earthquakes';

export default function create(ctx) {
  const { map, feed, detail } = ctx;
  const quakes = new Map(); // id -> quake
  let minMag = 2.5;
  let selected = null;
  let last = EMPTY; // the FeatureCollection currently pushed to the source

  const filter = el('div', { class: 'filter' });
  const output = el('output', {}, minMag.toFixed(1));
  const slider = el('input', { type: 'range', min: '-1', max: '7', step: '0.5', value: String(minMag), 'aria-label': 'Minimum earthquake magnitude' });
  filter.append(el('label', {}, 'Min. earthquake magnitude', output), slider,
    el('div', { class: 'hint' }, 'Size is magnitude, color is age.'),
    legend(AGE_COLORS.map(([, c, label]) => [c, label]), { label: 'Earthquake age colors' }));
  slider.addEventListener('input', () => {
    minMag = Number(slider.value);
    output.textContent = minMag.toFixed(1);
    applyFilter();
    feed.refresh();
  });
  ctx.addFilter(filter);

  const passes = (q) => (q.mag ?? -Infinity) >= minMag;

  // Style edits are only legal while a style is loaded; otherwise mount() re-applies.
  const canEdit = () => !!map && ctx.ready();

  // The magnitude filter runs on the GPU: no re-tiling of the source.
  function applyFilter() {
    if (!canEdit()) return;
    if (map.getLayer(HALO)) map.setFilter(HALO, haloFilter(minMag));
    if (map.getLayer(DOTS)) map.setFilter(DOTS, magFilter(minMag));
  }

  function setSelectedState(id, on) {
    if (id == null || !canEdit() || !map.getSource(SRC)) return;
    if (on) map.setFeatureState({ source: SRC, id }, { selected: true });
    else map.removeFeatureState({ source: SRC, id });
  }

  // Rebuild the collection (age buckets move with the clock) and push it.
  function render() {
    const now = Date.now();
    last = fc([...quakes.values()].map((q) => quakeFeature(q, now)));
    map?.getSource(SRC)?.setData(last);
  }

  function showDetail(q) {
    detail.show({
      key: `earthquakes:${q.id}`,
      color: ageColor(q.time),
      kind: 'Earthquake',
      heading: `M ${num(q.mag, 1)} · ${q.place || 'Unknown location'}`,
      fields: [
        ['Magnitude', `${num(q.mag, 1)} ${q.magType || ''}`.trim()],
        ['Depth', q.depth != null ? `${num(q.depth, 1)} km` : null],
        ['Time', dateTime(q.time), timeAgo(q.time)],
        ['Location', latLon(q.lat, q.lon)],
        ['Status', q.status],
        ['Felt reports', q.felt || null],
        ['PAGER alert', q.alert],
        ['Tsunami flag', q.tsunami ? 'Yes' : null],
      ],
      link: q.url ? { href: q.url, label: 'Open on USGS ↗' } : null,
      latlng: [q.lat, q.lon],
      radius: radiusFor(q.mag),
    });
  }

  function select(id) {
    if (selected !== null && selected !== id) setSelectedState(selected, false);
    selected = id;
    const cur = quakes.get(id);
    if (!cur) return false;
    ctx.select(api);
    setSelectedState(id, true);
    showDetail(cur);
    return true;
  }

  // Select first, then fly: taking the selection pauses the ambient spin with
  // map.stop(), which would cancel a flight already under way.
  function focus(id) {
    const cur = quakes.get(id);
    if (!cur || !api.visible) return;
    select(id);
    ctx.flyTo({ center: [cur.lon, cur.lat], minZoom: 5 });
  }

  function update({ quakes: fresh }) {
    const seen = new Set();
    for (const q of fresh) {
      seen.add(q.id);
      const existing = quakes.get(q.id);
      const prevMag = existing?.mag;
      quakes.set(q.id, q);
      if (!existing || prevMag !== q.mag) {
        feed.add({
          id: `earthquakes:${q.id}`,
          replace: true,
          source: 'earthquakes',
          time: q.time,
          mag: q.mag,
          significant: q.mag >= 6,
          latlng: [q.lat, q.lon],
          radius: radiusFor(q.mag),
          color: ageColor(q.time),
          title: `M ${num(q.mag, 1)} earthquake`,
          subtitle: `${q.place || latLon(q.lat, q.lon)} · ${num(q.depth, 0)} km deep`,
          onClick: () => focus(q.id),
        });
      }
    }
    for (const id of [...quakes.keys()]) {
      if (seen.has(id)) continue;
      quakes.delete(id);
      feed.remove(`earthquakes:${id}`);
      if (id === selected) {
        setSelectedState(id, false);
        detail.hide();
      }
    }
    render();
    if (selected !== null && quakes.has(selected) && detail.key === `earthquakes:${selected}`) showDetail(quakes.get(selected));
  }

  // Ages move on even without new data, so re-bucket every minute. Nothing to do
  // while the tab is hidden or the layer is off; catch up as soon as the tab is back.
  setInterval(() => {
    if (document.hidden || !api.visible || !quakes.size) return;
    render();
  }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && api.visible && quakes.size) render();
  });

  // Runs after every style load: everything the style forgot is added again, the
  // cached data re-pushed, and the current filter and selection re-applied.
  function mount() {
    ctx.addSource(SRC, { type: 'geojson', promoteId: 'id', data: last, maxzoom: 10, buffer: 16 });
    ctx.addLayer({
      id: HALO,
      type: 'circle',
      source: SRC,
      filter: haloFilter(minMag),
      paint: {
        'circle-radius': ['+', ['get', 'r'], 6],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': AGE_COLORS[0][1],
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.3,
        'circle-pitch-alignment': 'map',
      },
    }, 'points');
    ctx.addLayer({
      id: DOTS,
      type: 'circle',
      source: SRC,
      filter: magFilter(minMag),
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': AGE,
        'circle-opacity': AGE_OPACITY,
        'circle-stroke-color': ['case', SEL, '#ffffff', AGE],
        'circle-stroke-width': ['case', SEL, 2.5, 1],
        'circle-stroke-opacity': 0.9,
        'circle-pitch-alignment': 'viewport',
        'circle-pitch-scale': 'viewport',
      },
    }, 'points');
    map?.getSource(SRC)?.setData(last);
    applyFilter();
    if (selected !== null && quakes.has(selected)) setSelectedState(selected, true);
  }

  const api = {
    id: 'earthquakes',
    name: 'Earthquakes',
    source: 'USGS',
    color: '#f5a524',
    visible: true,
    layerIds: [HALO, DOTS],
    interactive: [{ layer: DOTS, priority: 40 }],
    mount,
    update,
    focusFirst() {
      const top = [...quakes.values()].filter(passes).sort((a, b) => b.mag - a.mag)[0];
      if (top) focus(top.id);
      return !!top;
    },
    count: () => [...quakes.values()].filter(passes).length,
    acceptsFeed: (entry) => (entry.mag ?? -Infinity) >= minMag,
    pick(feature) {
      const id = feature.id ?? feature.properties?.id;
      if (id == null || !quakes.has(id)) return false;
      return select(id);
    },
    clearSelection() {
      if (selected !== null) setSelectedState(selected, false);
      selected = null;
    },
  };
  return api;
}
