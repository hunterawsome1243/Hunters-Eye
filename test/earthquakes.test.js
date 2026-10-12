import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalize } from '../server/sources/earthquakes.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/usgs-all-day.json', import.meta.url)));

test('normalizes USGS GeoJSON into flat quake records', () => {
  const quakes = normalize(fixture);
  assert.equal(quakes.length, 4);
  const q = quakes[0];
  assert.equal(q.id, 'us7000aaa1');
  assert.equal(q.mag, 5.8);
  assert.equal(q.lon, 142.3);
  assert.equal(q.lat, 38.1);
  assert.equal(q.depth, 35.2);
  assert.equal(q.tsunami, false);
});

test('skips features without coordinates', () => {
  const quakes = normalize({ features: [{ id: 'a', properties: {}, geometry: null }, ...fixture.features.slice(0, 1)] });
  assert.equal(quakes.length, 1);
});
