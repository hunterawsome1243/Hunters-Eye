import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGERY, buildStyle, buildingsIndex, fallbackStyle, imageryIndex } from '../public/js/globe/style.js';

// The layer order OpenFreeMap's dark style actually has (ids and types only).
const dark = () => ({
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000' } },
    { id: 'water', type: 'fill' },
    { id: 'landcover_ice_shelf', type: 'fill' },
    { id: 'landcover_glacier', type: 'fill' },
    { id: 'landuse_residential', type: 'fill' },
    { id: 'landcover_wood', type: 'fill' },
    { id: 'landuse_park', type: 'fill' },
    { id: 'waterway', type: 'line' },
    { id: 'water_name', type: 'symbol' },
    { id: 'building', type: 'fill' },
    { id: 'tunnel_motorway_casing', type: 'line' },
    { id: 'road_major', type: 'line' },
    { id: 'boundary_state', type: 'line' },
    { id: 'place_city', type: 'symbol' },
  ],
});
const ids = (style) => style.layers.map((l) => l.id);

test('imagery goes above the opening run of fills and below the first line', () => {
  const style = buildStyle(dark(), { imagery: IMAGERY.eox2017 });
  const order = ids(style);
  assert.equal(order[order.indexOf('he-imagery') - 1], 'landuse_park');
  assert.equal(order[order.indexOf('he-imagery') + 1], 'waterway');
  assert.equal(style.sources['he-imagery'].tiles[0], IMAGERY.eox2017.tiles);
  assert.equal(style.sources['he-imagery'].maxzoom, 12);
  const deep = buildStyle(dark(), { imagery: { ...IMAGERY.eox2017, maxzoom: 18 } });
  assert.equal(deep.sources['he-imagery'].maxzoom, 18);
  assert.equal(deep.layers.find((l) => l.id === 'he-imagery').maxzoom, 12);
  assert.equal(style.layers.find((l) => l.id === 'he-imagery').source, 'he-imagery');
});

test('imagery falls back to after water, then to index 1', () => {
  assert.equal(imageryIndex([{ id: 'x', type: 'line' }, { id: 'water', type: 'line' }, { id: 'y', type: 'line' }]), 2);
  assert.equal(imageryIndex([{ id: 'x', type: 'line' }, { id: 'y', type: 'symbol' }]), 1);
  assert.equal(imageryIndex([]), 0);
});

test('no imagery when none is configured', () => {
  const style = buildStyle(dark(), { imagery: null });
  assert.ok(!ids(style).includes('he-imagery'));
  assert.ok(!style.sources['he-imagery']);
});

test('projection, sky and light are set and glyphs kept', () => {
  const style = buildStyle(dark(), {});
  assert.deepEqual(style.projection.type.slice(0, 3), ['interpolate', ['linear'], ['zoom']]);
  assert.ok(style.sky['atmosphere-blend']);
  assert.equal(style.light.anchor, 'viewport');
  assert.ok(style.glyphs.includes('fontstack'));
  assert.ok(style.sprite);
});

test('the background is recoloured only when the style has one', () => {
  const style = buildStyle(dark(), {});
  assert.equal(style.layers[0].paint['background-color'], '#0f141b');
  const bare = buildStyle({ version: 8, sources: {}, layers: [{ id: 'water', type: 'fill' }] }, {});
  assert.ok(!bare.layers.some((l) => l.type === 'background'));
});

test('3D buildings go right after the building footprints, once, only with openmaptiles', () => {
  const style = buildStyle(dark(), {});
  const order = ids(style);
  assert.equal(order[order.indexOf('he-buildings-3d') - 1], 'building');
  assert.equal(order.filter((id) => id === 'he-buildings-3d').length, 1);
  const again = buildStyle(style, {});
  assert.equal(ids(again).filter((id) => id === 'he-buildings-3d').length, 1);
  const withOwn = dark();
  withOwn.layers.push({ id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles' });
  assert.ok(!ids(buildStyle(withOwn, {})).includes('he-buildings-3d'));
  assert.ok(!ids(buildStyle(fallbackStyle(), {})).includes('he-buildings-3d'));
  assert.equal(buildingsIndex([{ id: 'a', type: 'fill' }, { id: 'b', type: 'line' }, { id: 'c', type: 'symbol' }]), 2);
});

test('buildStyle is pure', () => {
  const base = dark();
  const before = JSON.stringify(base);
  buildStyle(base, { imagery: IMAGERY.eox2017 });
  assert.equal(JSON.stringify(base), before);
});

test('the fallback style has no glyphs and takes imagery between land and coastlines', () => {
  const style = fallbackStyle();
  assert.ok(!style.glyphs);
  assert.ok(ids(style).includes('he-land-fill'));
  const order = ids(buildStyle(style, { imagery: IMAGERY.bluemarble }));
  assert.equal(order[order.indexOf('he-imagery') - 1], 'he-land-fill');
  assert.equal(order[order.indexOf('he-imagery') + 1], 'he-land-line');
});

test('every imagery preset is a 256px keyless tile set with attribution', () => {
  for (const [name, p] of Object.entries(IMAGERY)) {
    assert.ok(p.tiles.startsWith('https://') && p.tiles.includes('{z}'), name);
    assert.ok(!/key|token/i.test(p.tiles), name);
    assert.ok(p.attribution.length > 10, name);
    assert.equal(p.minzoom, 1, name);
  }
  assert.equal(IMAGERY.bluemarble.maxzoom, 7);
  assert.equal(IMAGERY.night.maxzoom, 7);
});
