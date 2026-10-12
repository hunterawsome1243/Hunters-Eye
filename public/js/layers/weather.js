import { dateTime, el, timeAgo } from '../ui/format.js';
import { legend } from '../ui/legend.js';

const COLOR = '#f43f5e';
// A rose family that steps in lightness, with the fill opacity and the stroke weight
// following severity, so the difference survives the alpha blend on the map.
const SEVERITY = {
  Extreme: { color: '#ff8fc6', fill: 0.34, weight: 2, rank: 0 },
  Severe: { color: '#e11d48', fill: 0.26, weight: 1, rank: 1 },
  Moderate: { color: '#c9707e', fill: 0.22, weight: 1, rank: 2 },
  Minor: { color: '#c7a6ae', fill: 0.2, weight: 1, rank: 3 },
  Unknown: { color: '#605d66', fill: 0.14, weight: 1, rank: 4 },
};

export default function create(ctx) {
  const { map, feed, detail } = ctx;
  const group = L.featureGroup();
  const shapes = new Map(); // id -> { alert, layer|null }
  let selected = null;
  let maxRank = SEVERITY.Unknown.rank;

  const picker = el('select', { 'aria-label': 'Minimum weather alert severity' },
    el('option', { value: '4' }, 'All alerts'),
    el('option', { value: '2' }, 'Moderate and up'),
    el('option', { value: '1' }, 'Severe and up'),
    el('option', { value: '0' }, 'Extreme only'));
  picker.addEventListener('change', () => {
    maxRank = Number(picker.value);
    for (const s of shapes.values()) applyVisibility(s);
    feed.refresh();
  });
  ctx.addFilter(el('div', { class: 'filter' },
    el('label', {}, 'Weather alerts', picker),
    legend(Object.entries(SEVERITY).map(([name, { color }]) => [color, name]), { shape: 'square', label: 'Alert severity colors' })));

  const passes = (a) => (SEVERITY[a.severity] || SEVERITY.Unknown).rank <= maxRank;
  function applyVisibility(s) {
    if (!s.layer) return;
    const show = passes(s.alert);
    if (show && !group.hasLayer(s.layer)) group.addLayer(s.layer);
    else if (!show && group.hasLayer(s.layer)) group.removeLayer(s.layer);
  }

  function style(a, isSelected) {
    const { color, fill, weight } = SEVERITY[a.severity] || SEVERITY.Unknown;
    return { color: isSelected ? '#ffffff' : color, weight: isSelected ? 2.5 : weight, opacity: 0.9, fillColor: color, fillOpacity: isSelected ? 0.4 : fill };
  }

  function showDetail(a) {
    detail.show({
      key: `weather:${a.id}`,
      color: (SEVERITY[a.severity] || SEVERITY.Unknown).color,
      kind: `Weather alert · ${a.severity}`,
      heading: a.event,
      fields: [
        ['Area', a.areaDesc],
        ['Urgency', a.urgency],
        ['Certainty', a.certainty],
        ['Issued', a.sent ? dateTime(a.sent) : null, a.sent ? timeAgo(a.sent) : null],
        ['Expires', a.expires ? dateTime(a.expires) : null],
        ['Issued by', a.sender],
      ],
      notes: [a.headline, a.description, a.instruction].filter(Boolean).join('\n\n') + (shapes.get(a.id)?.layer ? '' : '\n\nNo outline available for this alert yet.'),
    });
  }

  function select(id) {
    const prev = shapes.get(selected);
    if (prev?.layer) prev.layer.setStyle(style(prev.alert, false));
    selected = id;
    const cur = shapes.get(id);
    if (!cur) return;
    ctx.select(api);
    if (cur.layer) cur.layer.setStyle(style(cur.alert, true));
    showDetail(cur.alert);
  }

  function focus(id) {
    const cur = shapes.get(id);
    if (!cur || !map.hasLayer(group)) return;
    if (cur.layer) map.flyToBounds(cur.layer.getBounds(), { maxZoom: 8, duration: 0.8, padding: [40, 40] });
    select(id);
  }

  function update({ alerts, zones }) {
    api.urgent = alerts.some((a) => a.severity === 'Extreme');
    const seen = new Set(alerts.map((a) => a.id));
    for (const [id, s] of shapes) {
      if (seen.has(id)) continue;
      if (s.layer) group.removeLayer(s.layer);
      shapes.delete(id);
      feed.remove(`weather:${id}`);
      if (id === selected) detail.hide();
    }
    // Least severe first so the worst alerts end up drawn on top.
    const ordered = [...alerts].sort((a, b) => SEVERITY[b.severity].rank - SEVERITY[a.severity].rank);
    for (const a of ordered) {
      const polygons = a.polygons.length ? a.polygons : a.zoneIds.flatMap((z) => zones[z] || []);
      const existing = shapes.get(a.id);
      const hadShape = !!existing?.layer;
      if (existing?.layer && (polygons.length !== existing.polygonCount)) {
        group.removeLayer(existing.layer);
        existing.layer = null;
      }
      const entry = existing || { alert: a, layer: null, polygonCount: 0 };
      entry.alert = a;
      if (!entry.layer && polygons.length) {
        entry.layer = L.geoJSON({ type: 'MultiPolygon', coordinates: polygons }, { style: style(a, a.id === selected), bubblingMouseEvents: false });
        // A plane inside the alert area wins over the area itself.
        entry.layer.on('click', (e) => ctx.pick(e.containerPoint) || select(a.id));
        entry.polygonCount = polygons.length;
      } else if (entry.layer && hadShape) {
        entry.layer.setStyle(style(a, a.id === selected));
      }
      shapes.set(a.id, entry);
      applyVisibility(entry);
      if (!existing) {
        feed.add({
          id: `weather:${a.id}`,
          source: 'weather',
          time: a.sent ?? Date.now(),
          severity: a.severity,
          significant: a.severity === 'Extreme' || a.severity === 'Severe',
          latlng: entry.layer?.getBounds?.().getCenter() ?? null,
          radius: 10,
          color: (SEVERITY[a.severity] || SEVERITY.Unknown).color,
          title: a.event,
          subtitle: a.areaDesc,
          onClick: () => focus(a.id),
        });
      }
    }
    // All vectors share one canvas, and the last one added is drawn on top and gets
    // the click. Keep alert areas beneath quakes and satellites, worst alerts uppermost.
    for (const a of [...alerts].sort((x, y) => SEVERITY[x.severity].rank - SEVERITY[y.severity].rank)) {
      shapes.get(a.id)?.layer?.bringToBack();
    }
    if (selected && shapes.has(selected) && detail.key === `weather:${selected}`) showDetail(shapes.get(selected).alert);
  }

  const api = {
    id: 'weather',
    name: 'Severe weather',
    source: 'US National Weather Service',
    color: COLOR,
    layer: group,
    visible: true,
    update,
    count: () => [...shapes.values()].filter((s) => passes(s.alert)).length,
    acceptsFeed: (entry) => passes(entry),
    focusFirst() {
      const first = [...shapes.values()].filter((s) => s.layer && passes(s.alert)).sort((a, b) => SEVERITY[a.alert.severity].rank - SEVERITY[b.alert.severity].rank)[0];
      if (first) focus(first.alert.id);
      return !!first;
    },
    clearSelection() {
      const prev = shapes.get(selected);
      if (prev?.layer) prev.layer.setStyle(style(prev.alert, false));
      selected = null;
    },
  };
  return api;
}
