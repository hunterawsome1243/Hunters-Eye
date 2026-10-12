import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageryConfig } from '../server/app.js';

test('imagery defaults to EOX Sentinel-2 cloudless with its attribution', () => {
  const c = imageryConfig({});
  assert.ok(c.tiles.includes('s2cloudless-2017'));
  assert.ok(c.attribution.includes('EOX'));
  assert.equal(c.maxzoom, 12);
});

test('IMAGERY_TILES overrides, an empty value turns imagery off', () => {
  const c = imageryConfig({ IMAGERY_TILES: 'https://example.test/{z}/{x}/{y}.png', IMAGERY_MAXZOOM: '7' });
  assert.equal(c.tiles, 'https://example.test/{z}/{x}/{y}.png');
  assert.equal(c.attribution, '');
  assert.equal(c.maxzoom, 7);
  assert.equal(imageryConfig({ IMAGERY_TILES: '' }), null);
  assert.equal(imageryConfig({ IMAGERY_ATTRIBUTION: 'x' }).attribution, 'x');
});
