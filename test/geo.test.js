import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundsOf, footprintRadiusKm, geodesicCircle, inBox, padBox, recentre, unwrapLine, unwrapPolygons, unwrapRing } from '../public/js/globe/geo.js';

const haversineKm = ([lon1, lat1], [lon2, lat2]) => {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
};
const maxDelta = (coords) => Math.max(...coords.slice(1).map(([lon], i) => Math.abs(lon - coords[i][0])));

test('unwrapLine keeps longitude steps under 180', () => {
  assert.deepEqual(unwrapLine([[170, 0], [178, 0], [-178, 0]]).map(([lon]) => lon), [170, 178, 182]);
  assert.deepEqual(unwrapLine([[-170, 0], [-178, 0], [178, 0]]).map(([lon]) => lon), [-170, -178, -182]);
});

test('a 1.5-orbit track stays inside ±540 after recentring', () => {
  // A satellite ground track drifts about 22.5° west per orbit; fake 1.5 orbits of it.
  const pts = [];
  for (let i = 0; i <= 540; i += 5) pts.push([((i * 0.98 + 170 + 180) % 360) - 180, 50 * Math.sin((i * Math.PI) / 180)]);
  const line = recentre(unwrapLine(pts));
  assert.ok(maxDelta(line) < 180);
  assert.ok(line.every(([lon]) => Math.abs(lon) <= 540));
  const mid = line[Math.floor(line.length / 2)][0];
  assert.ok(mid >= -180 && mid <= 180);
  const span = Math.max(...line.map(([lon]) => lon)) - Math.min(...line.map(([lon]) => lon));
  assert.ok(span > 500 && span < 540, `span ${span}`);
});

test('unwrapRing keeps the ring closed and spans the antimeridian continuously', () => {
  const ring = unwrapRing([[175, 10], [-175, 10], [-175, 20], [175, 20], [175, 10]]);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(maxDelta(ring) < 180);
});

test('unwrapRing turns a ring around the pole into a cap', () => {
  const coast = [];
  for (let lon = -180; lon <= 180; lon += 10) coast.push([lon, -84]);
  const ring = unwrapRing(coast);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(ring.some(([, lat]) => lat < -89.9), 'has polar vertices');
});

test('unwrapPolygons keeps a hole next to its outer ring', () => {
  const outer = [[175, 0], [-175, 0], [-175, 5], [175, 5], [175, 0]];
  const hole = [[178, 1], [-178, 1], [-178, 2], [178, 2], [178, 1]];
  const [[o, h]] = unwrapPolygons([[outer, hole]]);
  assert.ok(maxDelta(o) < 180 && maxDelta(h) < 180);
  const mid = (ring) => (Math.min(...ring.map(([lon]) => lon)) + Math.max(...ring.map(([lon]) => lon))) / 2;
  assert.ok(Math.abs(mid(o) - mid(h)) < 10, `hole ${mid(h)} vs outer ${mid(o)}`);
  assert.deepEqual(h[0], h[h.length - 1]);
});

test('geodesicCircle vertices sit at the radius and the ring closes', () => {
  const ring = geodesicCircle(10, 45, 2000, 36);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  for (const p of ring.slice(0, -1)) {
    const d = haversineKm([10, 45], p);
    assert.ok(Math.abs(d - 2000) / 2000 < 0.001, `distance ${d}`);
  }
  assert.ok(maxDelta(ring) < 180);
});

test('geodesicCircle over a pole returns a polar cap', () => {
  const ring = geodesicCircle(0, 70, 25 * 111.2, 36);
  assert.ok(ring.some(([lon, lat]) => lon === 180 && lat === 89.9));
  assert.ok(ring.some(([lon, lat]) => lon === -180 && lat === 89.9));
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  const lons = ring.slice(0, -3).map(([lon]) => lon);
  assert.deepEqual(lons, [...lons].sort((a, b) => a - b));
});

test('footprintRadiusKm matches the horizon formula', () => {
  assert.ok(Math.abs(footprintRadiusKm(420) - 2270) < 20);
  assert.equal(footprintRadiusKm(0), 0);
});

test('inBox wraps the longitude to the box centre', () => {
  const box = { lamin: 0, lomin: 109, lamax: 50, lomax: 248 };
  assert.ok(inBox(box, 10, 181));
  assert.ok(inBox(box, 10, -179));
  assert.ok(!inBox(box, 10, 100));
  assert.ok(!inBox(box, 60, 180));
  assert.ok(inBox(null, 0, 0));
  assert.ok(inBox({ lamin: -90, lomin: -180, lamax: 90, lomax: 180 }, 0, 500));
});

test('padBox grows each side by a fraction and clamps latitude', () => {
  const box = padBox({ lamin: 80, lomin: 0, lamax: 90, lomax: 10 }, 0.5);
  assert.deepEqual(box, { lamin: 75, lamax: 90, lomin: -5, lomax: 15 });
});

test('boundsOf covers the unwrapped polygons', () => {
  const b = boundsOf([[[[175, 10], [-175, 10], [-175, 20], [175, 20], [175, 10]]]]);
  assert.equal(b[1][0] - b[0][0], 10);
  assert.deepEqual([b[0][1], b[1][1]], [10, 20]);
  assert.equal(boundsOf([]), null);
});
