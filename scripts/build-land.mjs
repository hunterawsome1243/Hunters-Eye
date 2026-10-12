// Builds public/data/land-110m.geojson: Natural Earth 1:110m land from the
// world-atlas package, rings unwrapped for the globe and rounded to 2 dp. The
// file is committed; run `node scripts/build-land.mjs` only to refresh it.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import { unwrapRing } from '../public/js/globe/geo.js';

const require = createRequire(import.meta.url);
const topo = JSON.parse(await readFile(require.resolve('world-atlas/land-110m.json'), 'utf8'));
const land = feature(topo, topo.objects.land);
// feature() gives one Feature or, for a GeometryCollection, a FeatureCollection.
const geometries = (land.type === 'FeatureCollection' ? land.features : [land]).map((f) => f.geometry);

const round = (v) => Math.round(v * 100) / 100;
const multi = geometries.flatMap((g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates));
const coordinates = multi.map((polygon) => polygon.map((ring) => unwrapRing(ring).map(([lon, lat]) => [round(lon), round(lat)])));

const out = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { name: 'land', source: 'Natural Earth 1:110m via world-atlas' }, geometry: { type: 'MultiPolygon', coordinates } }],
};
const target = fileURLToPath(new URL('../public/data/land-110m.geojson', import.meta.url));
await writeFile(target, JSON.stringify(out));
console.log(`${target}: ${coordinates.length} polygons, ${(Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0)} KB`);
