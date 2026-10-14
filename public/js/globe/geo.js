// Pure geometry helpers for drawing on the globe. No DOM, no MapLibre: Node can
// import this file, so test/geo.test.js exercises it directly.
//
// Coordinates are GeoJSON order, [lon, lat]. Longitudes may leave [-180, 180]:
// MapLibre's tiler wraps anything within ±540° back onto the one world, so a
// line that crosses the antimeridian is drawn continuously when its longitudes
// are "unwrapped" (consecutive deltas kept under 180°) instead of split.

export const EMPTY = { type: 'FeatureCollection', features: [] };
export const fc = (features) => ({ type: 'FeatureCollection', features });

// For paint expressions: true while the feature's state has selected: true.
export const SEL = ['boolean', ['feature-state', 'selected'], false];

const EARTH_RADIUS_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Keep every longitude step under 180° by adding or subtracting whole turns:
// 170, 178, -178 becomes 170, 178, 182.
export function unwrapLine(coords) {
  const out = [];
  let shift = 0;
  let prev = null;
  for (const [lon, lat, ...rest] of coords) {
    if (prev !== null) {
      const d = lon + shift - prev;
      if (d > 180) shift -= 360;
      else if (d < -180) shift += 360;
    }
    prev = lon + shift;
    out.push([prev, lat, ...rest]);
  }
  return out;
}

// Shift the whole line by whole turns so its middle vertex sits in [-180, 180].
export function recentre(coords) {
  if (!coords.length) return coords;
  const mid = coords[Math.floor(coords.length / 2)][0];
  const shift = -360 * Math.round(mid / 360);
  return shift ? coords.map(([lon, lat, ...rest]) => [lon + shift, lat, ...rest]) : coords.slice();
}

// A polygon ring, unwrapped and recentred, still closed. A ring that goes all
// the way round a pole (Antarctica's coast) ends a full turn away from where it
// started; it gets two polar vertices so the cap fills instead of collapsing to
// a band.
export function unwrapRing(ring) {
  const out = recentre(unwrapLine(ring));
  if (out.length < 2) return out;
  const first = out[0];
  const last = out[out.length - 1];
  if (Math.abs(Math.abs(last[0] - first[0]) - 360) < 1e-6) {
    const meanLat = out.reduce((sum, [, lat]) => sum + lat, 0) / out.length;
    const poleLat = meanLat < 0 ? -89.99 : 89.99;
    out.push([last[0], poleLat], [first[0], poleLat], [first[0], first[1]]);
  } else if (last[0] !== first[0] || last[1] !== first[1]) {
    out.push([first[0], first[1]]);
  }
  return out;
}

// MultiPolygon coordinates with every ring unwrapped (western Aleutian zones
// and polar caps cross 180°). Holes take the same shift as their outer ring, so
// a polygon never ends up with its hole a world away.
export function unwrapPolygons(multi) {
  return multi.map((polygon) => {
    const outer = unwrapRing(polygon[0]);
    const raw = unwrapLine(polygon[0]);
    const shift = raw.length ? outer[0][0] - raw[0][0] : 0;
    const holes = polygon.slice(1).map((ring) => {
      const line = unwrapLine(ring);
      const mid = line[Math.floor(line.length / 2)]?.[0] ?? 0;
      // Put the hole next to the outer ring, then close it.
      const near = -360 * Math.round((mid - (raw[Math.floor(raw.length / 2)]?.[0] ?? 0)) / 360);
      const out = line.map(([lon, lat, ...rest]) => [lon + near + shift, lat, ...rest]);
      const [a, b] = [out[0], out[out.length - 1]];
      if (a && b && (a[0] !== b[0] || a[1] !== b[1])) out.push([a[0], a[1]]);
      return out;
    });
    return [outer, ...holes];
  });
}

// Ground radius inside which a satellite at altKm is above the horizon.
export function footprintRadiusKm(altKm) {
  return EARTH_RADIUS_KM * Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + Math.max(altKm, 0)));
}

// Closed ring of points at great-circle distance radiusKm around [lon, lat].
// If the circle contains a pole, the ring is returned sorted by longitude with
// two polar vertices appended, so the cap is a valid, fillable polygon.
export function geodesicCircle(lon, lat, radiusKm, n = 72) {
  const ang = radiusKm / EARTH_RADIUS_KM;
  const angDeg = deg(ang);
  const lat1 = rad(lat);
  const lon1 = rad(lon);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const brg = (2 * Math.PI * i) / n;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(brg));
    const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(ang) * Math.cos(lat1), Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2));
    pts.push([((deg(lon2) + 540) % 360) - 180, deg(lat2)]);
  }
  if (Math.abs(lat) + angDeg >= 89.5) {
    const poleLat = lat >= 0 ? 89.9 : -89.9;
    pts.sort((a, b) => a[0] - b[0]);
    pts.push([180, poleLat], [-180, poleLat]);
    pts.push([pts[0][0], pts[0][1]]);
    return pts;
  }
  pts.push([pts[0][0], pts[0][1]]);
  return unwrapRing(pts);
}

// [[minLon, minLat], [maxLon, maxLat]] of MultiPolygon coordinates after unwrapping.
// Each part is moved to the world copy nearest the first part: NWS serves a zone that
// straddles 180° (the western Aleutians) as parts on both sides, whose plain bounds
// span the whole world with their middle at longitude 0.
export function boundsOf(multi) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  let ref = null;
  for (const polygon of unwrapPolygons(multi)) {
    const ring = polygon[0] ?? [];
    if (!ring.length) continue;
    ref ??= ring[0][0];
    const shift = nearLon(ring[0][0], ref) - ring[0][0];
    for (const [lon0, lat] of ring) {
      const lon = lon0 + shift;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return Number.isFinite(minLon) ? [[minLon, minLat], [maxLon, maxLat]] : null;
}

// Grow a { lamin, lomin, lamax, lomax } box by a fraction of its size on each side.
export function padBox(box, f) {
  const dLat = (box.lamax - box.lamin) * f;
  const dLon = (box.lomax - box.lomin) * f;
  return {
    lamin: Math.max(-90, box.lamin - dLat),
    lamax: Math.min(90, box.lamax + dLat),
    lomin: box.lomin - dLon,
    lomax: box.lomax + dLon,
  };
}

// The copy of a longitude closest to a reference longitude.
export const nearLon = (lon, ref) => lon + 360 * Math.round((ref - lon) / 360);

// Is [lat, lon] inside the box? The longitude is wrapped to the box's centre
// first, so a box spanning 109..248 contains both 181 and -179.
export function inBox(box, lat, lon) {
  if (!box) return true;
  if (lat < box.lamin || lat > box.lamax) return false;
  if (box.lomax - box.lomin >= 360) return true;
  const l = nearLon(lon, (box.lomin + box.lomax) / 2);
  return l >= box.lomin && l <= box.lomax;
}

// Great-circle distance in km between two [lat, lon] points (haversine).
export function distanceKm([lat1, lon1], [lat2, lon2]) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// Initial bearing from one [lat, lon] to another, 0-360 clockwise from north.
export function bearingDeg([lat1, lon1], [lat2, lon2]) {
  const dLon = rad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassPoint(bearing) {
  return POINTS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}
