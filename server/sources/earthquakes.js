import { intervalFromEnv } from '../lib/env.js';
import { getJson } from '../lib/http.js';

// USGS real-time GeoJSON summary feed. Free, no key; USGS regenerates it every minute,
// so polling faster than that only re-downloads the same file.
// Docs: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
const URL_ = process.env.USGS_URL || 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

export function normalize(geojson) {
  return (geojson.features || [])
    .filter((f) => f?.geometry?.coordinates?.length >= 2)
    .map((f) => {
      const [lon, lat, depth] = f.geometry.coordinates;
      const p = f.properties || {};
      return {
        id: f.id,
        mag: p.mag,
        magType: p.magType,
        place: p.place,
        time: p.time,
        updated: p.updated,
        lat,
        lon,
        depth: depth ?? null,
        url: p.url,
        felt: p.felt,
        alert: p.alert,
        tsunami: p.tsunami === 1,
        status: p.status,
        type: p.type,
      };
    });
}

export default {
  id: 'earthquakes',
  name: 'Earthquakes',
  intervalMs: intervalFromEnv('EARTHQUAKES_INTERVAL_SEC', 60_000),
  errorRetryMs: 60_000,
  async fetch() {
    const geojson = await getJson(URL_, { headers: { Accept: 'application/geo+json, application/json' } });
    const quakes = normalize(geojson);
    return { data: { generated: geojson.metadata?.generated ?? null, quakes }, count: quakes.length };
  },
};
