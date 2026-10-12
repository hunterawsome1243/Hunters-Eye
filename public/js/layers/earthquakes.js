import { dateTime, el, latLon, num, timeAgo } from '../ui/format.js';

const HOUR = 3_600_000;
const AGE_COLORS = [
  [HOUR, '#ff4d4d', 'past hour'],
  [6 * HOUR, '#ff9f1c', 'past 6 hours'],
  [24 * HOUR, '#ffd93d', 'past day'],
  [Infinity, '#8a94a3', 'older'],
];

export const ageColor = (time, now = Date.now()) => AGE_COLORS.find(([max]) => now - time < max)[1];
export const radiusFor = (mag) => 2.5 + Math.max(0, mag ?? 0) ** 2 * 0.5;

export default function create(ctx) {
  const { map, feed, detail } = ctx;
  const group = L.featureGroup();
  const markers = new Map(); // id -> { quake, marker }
  let minMag = 2.5;
  let selected = null;

  const filter = el('div', { class: 'filter' });
  const output = el('output', {}, minMag.toFixed(1));
  const slider = el('input', { type: 'range', min: '-1', max: '7', step: '0.5', value: String(minMag), 'aria-label': 'Minimum earthquake magnitude' });
  filter.append(el('label', {}, 'Min. earthquake magnitude', output), slider,
    el('div', { class: 'hint' }, 'Circle size = magnitude, color = age: ',
      ...AGE_COLORS.flatMap(([, c, label], i) => [i ? ', ' : '', el('span', { style: `color:${c}` }, label)])));
  slider.addEventListener('input', () => {
    minMag = Number(slider.value);
    output.textContent = minMag.toFixed(1);
    applyFilter();
    feed.refresh();
  });
  ctx.addFilter(filter);

  const passes = (q) => (q.mag ?? -Infinity) >= minMag;

  function applyFilter() {
    for (const { quake, marker } of markers.values()) {
      const show = passes(quake);
      if (show && !group.hasLayer(marker)) group.addLayer(marker);
      else if (!show && group.hasLayer(marker)) group.removeLayer(marker);
    }
  }

  function style(q, isSelected) {
    const color = ageColor(q.time);
    return {
      radius: radiusFor(q.mag),
      color: isSelected ? '#ffffff' : color,
      weight: isSelected ? 2.5 : 1,
      fillColor: color,
      fillOpacity: 0.35,
      opacity: 0.9,
    };
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
        ['Time', `${dateTime(q.time)} (${timeAgo(q.time)})`],
        ['Location', latLon(q.lat, q.lon)],
        ['Status', q.status],
        ['Felt reports', q.felt || null],
        ['PAGER alert', q.alert],
        ['Tsunami flag', q.tsunami ? 'Yes' : null],
      ],
      link: q.url ? { href: q.url, label: 'Open on USGS ↗' } : null,
    });
  }

  function select(id) {
    const prev = selected && markers.get(selected);
    if (prev) prev.marker.setStyle(style(prev.quake, false));
    selected = id;
    const cur = markers.get(id);
    if (!cur) return;
    ctx.select(api);
    cur.marker.setStyle(style(cur.quake, true)).bringToFront();
    showDetail(cur.quake);
  }

  function focus(id) {
    const cur = markers.get(id);
    if (!cur) return;
    if (!map.hasLayer(group)) return;
    map.flyTo([cur.quake.lat, cur.quake.lon], Math.max(map.getZoom(), 5), { duration: 0.8 });
    select(id);
  }

  function update({ quakes }) {
    const seen = new Set();
    for (const q of quakes) {
      seen.add(q.id);
      const existing = markers.get(q.id);
      if (existing) {
        existing.quake = q;
        existing.marker.setLatLng([q.lat, q.lon]).setStyle(style(q, q.id === selected));
      } else {
        const marker = L.circleMarker([q.lat, q.lon], { ...style(q, false), bubblingMouseEvents: false });
        marker.on('click', () => select(q.id));
        markers.set(q.id, { quake: q, marker });
      }
      if (!existing || existing.quake.mag !== q.mag) {
        feed.add({
          id: `earthquakes:${q.id}`,
          replace: true,
          source: 'earthquakes',
          time: q.time,
          mag: q.mag,
          color: ageColor(q.time),
          title: `M ${num(q.mag, 1)} earthquake`,
          subtitle: `${q.place || latLon(q.lat, q.lon)} · ${num(q.depth, 0)} km deep`,
          onClick: () => focus(q.id),
        });
      }
    }
    for (const [id, { marker }] of markers) {
      if (seen.has(id)) continue;
      group.removeLayer(marker);
      markers.delete(id);
      feed.remove(`earthquakes:${id}`);
      if (id === selected) detail.hide();
    }
    applyFilter();
    if (selected && markers.has(selected) && detail.key === `earthquakes:${selected}`) showDetail(markers.get(selected).quake);
  }

  // Ages move on even without new data, so recolor every minute.
  setInterval(() => {
    for (const { quake, marker } of markers.values()) marker.setStyle(style(quake, quake.id === selected));
  }, 60_000);

  const api = {
    id: 'earthquakes',
    name: 'Earthquakes',
    source: 'USGS',
    color: '#ff9f1c',
    layer: group,
    visible: true,
    update,
    focusFirst() {
      const top = [...markers.values()].filter((m) => passes(m.quake)).sort((a, b) => b.quake.mag - a.quake.mag)[0];
      if (top) focus(top.quake.id);
      return !!top;
    },
    count: () => [...markers.values()].filter((m) => passes(m.quake)).length,
    acceptsFeed: (entry) => (entry.mag ?? -Infinity) >= minMag,
    clearSelection() {
      const prev = selected && markers.get(selected);
      if (prev) prev.marker.setStyle(style(prev.quake, false));
      selected = null;
    },
  };
  return api;
}
