import { dateTime, latLon, timeAgo } from '../ui/format.js';
import { EMPTY, SEL, fc } from '../globe/geo.js';

// Example globe layer for the natural events source. Copy this file to
// public/js/layers/events.js. It is the smallest layer that does everything the app
// expects: draw points, take clicks, open the detail panel, add feed entries.
// The contract every layer follows is documented at the top of layers/index.js.

const SRC = 'he-events';
const DOTS = 'he-events';
const COLOR = '#ff6b5a';

export default function create(ctx) {
  const { map, feed, detail } = ctx;
  const events = new Map(); // id -> event
  let selected = null;
  let last = EMPTY; // the FeatureCollection currently on the map

  // Style edits are only legal while a style is loaded; mount() re-applies the rest.
  function setSelectedState(id, on) {
    if (id == null || !map || !ctx.ready() || !map.getSource(SRC)) return;
    if (on) map.setFeatureState({ source: SRC, id }, { selected: true });
    else map.removeFeatureState({ source: SRC, id });
  }

  function showDetail(e) {
    detail.show({
      key: `events:${e.id}`,
      color: COLOR,
      kind: e.category,
      heading: e.title,
      fields: [
        ['Category', e.category],
        ['Last observed', dateTime(e.time), timeAgo(e.time)],
        ['Location', latLon(e.lat, e.lon)],
      ],
      link: e.url ? { href: e.url, label: 'Open on NASA EONET ↗' } : null,
      latlng: [e.lat, e.lon],
      radius: 6,
    });
  }

  function select(id) {
    if (selected !== null && selected !== id) setSelectedState(selected, false);
    selected = id;
    const e = events.get(id);
    if (!e) return false;
    ctx.select(api); // clears every other layer's selection
    setSelectedState(id, true);
    showDetail(e);
    return true;
  }

  function focus(id) {
    const e = events.get(id);
    if (!e || !api.visible) return;
    select(id);
    ctx.flyTo({ center: [e.lon, e.lat], minZoom: 5 });
  }

  // Called with the source's `data` each time the server has a new version.
  function update({ events: fresh }) {
    const seen = new Set(fresh.map((e) => e.id));
    for (const e of fresh) {
      if (!events.has(e.id)) {
        feed.add({
          id: `events:${e.id}`,
          source: 'events',
          time: e.time,
          latlng: [e.lat, e.lon],
          radius: 6,
          color: COLOR,
          title: e.title,
          subtitle: e.category,
          onClick: () => focus(e.id),
        });
      }
      events.set(e.id, e);
    }
    for (const id of [...events.keys()]) {
      if (seen.has(id)) continue;
      events.delete(id);
      feed.remove(`events:${id}`);
      if (id === selected) detail.hide();
    }
    last = fc([...events.values()].map((e) => ({
      type: 'Feature',
      id: e.id,
      properties: { id: e.id },
      geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
    })));
    map?.getSource(SRC)?.setData(last);
  }

  // Runs after every style load, so add everything again and re-push the data.
  function mount() {
    ctx.addSource(SRC, { type: 'geojson', promoteId: 'id', data: last });
    ctx.addLayer({
      id: DOTS,
      type: 'circle',
      source: SRC,
      paint: {
        'circle-radius': 5,
        'circle-color': COLOR,
        'circle-stroke-color': ['case', SEL, '#ffffff', '#0a0d12'],
        'circle-stroke-width': ['case', SEL, 2.5, 1.5],
        'circle-pitch-alignment': 'viewport',
      },
    }, 'points');
    map?.getSource(SRC)?.setData(last);
    if (selected !== null && events.has(selected)) setSelectedState(selected, true);
  }

  const api = {
    id: 'events', // must match the server source id
    name: 'Natural events',
    source: 'NASA EONET',
    color: COLOR,
    visible: true,
    layerIds: [DOTS],
    interactive: [{ layer: DOTS, priority: 30 }],
    mount,
    update,
    count: () => events.size,
    focusFirst() {
      const first = events.keys().next().value;
      if (first != null) focus(first);
      return first != null;
    },
    pick(feature) {
      const id = feature.id ?? feature.properties?.id;
      return id != null && events.has(id) && select(id);
    },
    clearSelection() {
      if (selected !== null) setSelectedState(selected, false);
      selected = null;
    },
  };
  return api;
}
