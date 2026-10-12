import { dateTime, el, timeAgo } from '../ui/format.js';
import { EMPTY, SEL, boundsOf, fc, unwrapPolygons } from '../globe/geo.js';

const COLOR = '#f43f5e';
export const SEVERITY = {
  Extreme: { color: '#d946ef', rank: 0 },
  Severe: { color: '#ef4444', rank: 1 },
  Moderate: { color: '#f97316', rank: 2 },
  Minor: { color: '#eab308', rank: 3 },
  Unknown: { color: '#94a3b8', rank: 4 },
};
const severityOf = (a) => SEVERITY[a.severity] || SEVERITY.Unknown;

const SRC = 'he-weather';
const FILL = 'he-weather-fill';
const LINE = 'he-weather-line';
// Alerts at or below this rank pass the severity filter.
export const rankFilter = (maxRank) => ['<=', ['get', 'rank'], maxRank];

// One GeoJSON feature per alert that has an outline. Western Aleutian zones and
// polar areas cross 180°, so every ring is unwrapped first.
export function alertFeature(a, polygons) {
  const { color, rank } = severityOf(a);
  return {
    type: 'Feature',
    id: a.id,
    properties: { id: a.id, rank, color },
    geometry: { type: 'MultiPolygon', coordinates: unwrapPolygons(polygons) },
  };
}

export default function create(ctx) {
  const { map, feed, detail } = ctx;
  const shapes = new Map(); // id -> { alert, feature|null, polygons, polygonCount }
  let last = EMPTY;
  let selected = null;
  let maxRank = SEVERITY.Unknown.rank;

  const picker = el('select', { 'aria-label': 'Minimum weather alert severity' },
    el('option', { value: '4' }, 'All alerts'),
    el('option', { value: '2' }, 'Moderate and up'),
    el('option', { value: '1' }, 'Severe and up'),
    el('option', { value: '0' }, 'Extreme only'));
  picker.addEventListener('change', () => {
    maxRank = Number(picker.value);
    applyFilter();
    feed.refresh();
  });
  ctx.addFilter(el('div', { class: 'filter' },
    el('label', {}, 'Weather alerts', picker),
    el('div', { class: 'hint' }, ...Object.entries(SEVERITY).flatMap(([name, { color }], i) => [i ? ' · ' : '', el('span', { style: `color:${color}` }, name)]))));

  const passes = (a) => severityOf(a).rank <= maxRank;

  // Style edits that throw while a style is loading; mount() repeats them after.
  const live = () => !!map && ctx.ready() && !!map.getLayer(FILL);

  function applyFilter() {
    if (!live()) return;
    const filter = rankFilter(maxRank);
    map.setFilter(FILL, filter);
    map.setFilter(LINE, filter);
  }

  function setSelectedState(id, on) {
    if (id == null || !live() || !map.getSource(SRC)) return;
    if (on) map.setFeatureState({ source: SRC, id }, { selected: true });
    else map.removeFeatureState({ source: SRC, id });
  }

  function render() {
    // Least severe first; fill-sort-key then keeps the worst alerts on top.
    const features = [...shapes.values()].filter((s) => s.feature).map((s) => s.feature)
      .sort((a, b) => b.properties.rank - a.properties.rank);
    last = fc(features);
    map?.getSource(SRC)?.setData(last);
  }

  function mount() {
    ctx.addSource(SRC, { type: 'geojson', promoteId: 'id', data: last, maxzoom: 10, buffer: 64, tolerance: 1 });
    ctx.addLayer({
      id: FILL, type: 'fill', source: SRC, filter: rankFilter(maxRank),
      layout: { 'fill-sort-key': ['-', 4, ['get', 'rank']] },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', SEL, 0.4, 0.22] },
    }, 'shapes');
    ctx.addLayer({
      id: LINE, type: 'line', source: SRC, filter: rankFilter(maxRank),
      layout: { 'line-sort-key': ['-', 4, ['get', 'rank']] },
      paint: { 'line-color': ['case', SEL, '#ffffff', ['get', 'color']], 'line-width': ['case', SEL, 2.5, 1], 'line-opacity': 0.9 },
    }, 'shapes');
    map?.getSource(SRC)?.setData(last);
    applyFilter();
    // Feature state does not survive a style swap.
    if (selected && shapes.has(selected)) setSelectedState(selected, true);
  }

  function showDetail(a) {
    detail.show({
      key: `weather:${a.id}`,
      color: severityOf(a).color,
      kind: `Weather alert · ${a.severity}`,
      heading: a.event,
      fields: [
        ['Area', a.areaDesc],
        ['Urgency', a.urgency],
        ['Certainty', a.certainty],
        ['Issued', a.sent ? `${dateTime(a.sent)} (${timeAgo(a.sent)})` : null],
        ['Expires', a.expires ? dateTime(a.expires) : null],
        ['Issued by', a.sender],
      ],
      notes: [a.headline, a.description, a.instruction].filter(Boolean).join('\n\n') + (shapes.get(a.id)?.feature ? '' : '\n\nNo outline available for this alert yet.'),
    });
  }

  function select(id) {
    const cur = shapes.get(id);
    if (!cur) return;
    if (selected !== null && selected !== id) setSelectedState(selected, false);
    selected = id;
    ctx.select(api);
    setSelectedState(id, true);
    showDetail(cur.alert);
  }

  function focus(id) {
    const cur = shapes.get(id);
    if (!cur || !api.visible) return;
    // Select first: ctx.select() pauses the spin with map.stop(), which would
    // cancel a camera move started just before it.
    select(id);
    if (cur.feature) {
      const bounds = boundsOf(cur.polygons);
      if (bounds) ctx.fitBounds(bounds, { maxZoom: 8, padding: 40 });
    }
  }

  function update({ alerts, zones }) {
    const seen = new Set(alerts.map((a) => a.id));
    for (const [id, s] of shapes) {
      if (seen.has(id)) continue;
      shapes.delete(id);
      feed.remove(`weather:${id}`);
      if (id === selected) {
        setSelectedState(id, false);
        selected = null;
        detail.hide();
      }
    }
    for (const a of alerts) {
      const polygons = a.polygons.length ? a.polygons : a.zoneIds.flatMap((z) => zones[z] || []);
      const existing = shapes.get(a.id);
      const entry = existing || { alert: a, feature: null, polygons: [], polygonCount: 0 };
      const severityChanged = existing && severityOf(existing.alert).rank !== severityOf(a).rank;
      entry.alert = a;
      // Rebuild the outline only when its polygon count changes (zone outlines arrive late).
      if (polygons.length !== entry.polygonCount || (severityChanged && entry.feature)) {
        entry.polygons = polygons;
        entry.polygonCount = polygons.length;
        entry.feature = polygons.length ? alertFeature(a, polygons) : null;
      }
      shapes.set(a.id, entry);
      if (!existing) {
        feed.add({
          id: `weather:${a.id}`,
          source: 'weather',
          time: a.sent ?? Date.now(),
          severity: a.severity,
          color: severityOf(a).color,
          title: a.event,
          subtitle: a.areaDesc,
          onClick: () => focus(a.id),
        });
      }
    }
    render();
    if (selected && shapes.has(selected) && detail.key === `weather:${selected}`) showDetail(shapes.get(selected).alert);
  }

  const api = {
    id: 'weather',
    name: 'Severe weather',
    source: 'US National Weather Service',
    color: COLOR,
    visible: true,
    layerIds: [FILL, LINE],
    interactive: [{ layer: FILL, priority: 10 }],
    mount,
    update,
    count: () => [...shapes.values()].filter((s) => passes(s.alert)).length,
    acceptsFeed: (entry) => passes(entry),
    focusFirst() {
      const first = [...shapes.values()].filter((s) => s.feature && passes(s.alert)).sort((a, b) => severityOf(a.alert).rank - severityOf(b.alert).rank)[0];
      if (first) focus(first.alert.id);
      return !!first;
    },
    pick(f) {
      if (f.layer?.id !== FILL) return false;
      const id = f.id ?? f.properties?.id;
      if (!shapes.has(id)) return false;
      select(id);
      return true;
    },
    clearSelection() {
      if (selected !== null) setSelectedState(selected, false);
      selected = null;
    },
  };
  return api;
}
