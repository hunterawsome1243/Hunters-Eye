import { bearingDeg, compassPoint, distanceKm } from '../globe/geo.js';

export const NEAR_LIMIT = 40; // the proximity feed: this many, nearest first

// The proximity feed's order: the entries with a position, nearest to `you` first,
// each given its distance and compass direction. Pure (no DOM), so test/feed-near.test.js can check it.
export function nearest(entries, you, limit = NEAR_LIMIT) {
  if (!you) return [];
  return entries
    .filter((e) => !e.system && Array.isArray(e.latlng))
    .map((e) => Object.assign(e, { km: distanceKm([you.lat, you.lon], e.latlng), dir: compassPoint(bearingDeg([you.lat, you.lon], e.latlng)) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

