import { getJson } from '../lib/http.js';

// Example data source: NASA EONET open natural events (wildfires, volcanoes, severe
// storms, sea and lake ice). Free, no key. Copy this file to server/sources/events.js.
// Docs: https://eonet.gsfc.nasa.gov/docs/v3
const URL_ = process.env.EONET_URL || 'https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&days=30';

// The GeoJSON endpoint has one feature per observation, so a storm tracked for a week
// appears several times. Keep the latest point of each event, and skip area events
// (polygons) to keep the example small.
export function normalize(geojson) {
  const byId = new Map();
  for (const f of geojson.features || []) {
    const p = f.properties || {};
    if (f.geometry?.type !== 'Point' || !p.id) continue;
    const [lon, lat] = f.geometry.coordinates;
    const time = Date.parse(p.date);
    const prev = byId.get(p.id);
    if (prev && prev.time >= time) continue;
    byId.set(p.id, {
      id: p.id,
      title: p.title,
      category: p.categories?.[0]?.title ?? 'Event',
      time,
      lat,
      lon,
      url: p.link,
    });
  }
  return [...byId.values()];
}

export default {
  id: 'events',
  name: 'Natural events',
  intervalMs: 15 * 60_000, // EONET changes slowly; every 15 minutes is plenty
  errorRetryMs: 5 * 60_000,
  async fetch() {
    const events = normalize(await getJson(URL_));
    return { data: { events }, count: events.length };
  },
};
