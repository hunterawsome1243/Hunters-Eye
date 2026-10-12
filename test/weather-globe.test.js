import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEVERITY, alertFeature, rankFilter } from '../public/js/layers/weather.js';

const box = (w, s, e, n) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];

test('alertFeature carries the promoted id, rank and colour', () => {
  const f = alertFeature({ id: 'urn:x', severity: 'Severe' }, [box(-97.7, 35.3, -97.2, 35.7)]);
  assert.equal(f.type, 'Feature');
  assert.equal(f.id, 'urn:x');
  assert.deepEqual(f.properties, { id: 'urn:x', rank: SEVERITY.Severe.rank, color: SEVERITY.Severe.color, fill: SEVERITY.Severe.fill, weight: SEVERITY.Severe.weight });
  assert.equal(f.geometry.type, 'MultiPolygon');
  assert.equal(f.geometry.coordinates.length, 1);
});

test('alertFeature treats an unknown severity as Unknown', () => {
  const f = alertFeature({ id: 'a', severity: 'Odd' }, [box(0, 0, 1, 1)]);
  assert.equal(f.properties.rank, SEVERITY.Unknown.rank);
  assert.equal(f.properties.color, SEVERITY.Unknown.color);
});

test('alertFeature unwraps an antimeridian-crossing zone into one continuous ring', () => {
  const f = alertFeature({ id: 'aleutian', severity: 'Minor' }, [box(179, 51, -179, 53)]);
  const lons = f.geometry.coordinates[0][0].map(([lon]) => lon);
  const maxStep = Math.max(...lons.slice(1).map((l, i) => Math.abs(l - lons[i])));
  assert.ok(maxStep < 180, `step ${maxStep}`);
});

test('rankFilter passes alerts at or below the chosen rank', () => {
  assert.deepEqual(rankFilter(2), ['<=', ['get', 'rank'], 2]);
  assert.deepEqual(rankFilter(0), ['<=', ['get', 'rank'], 0]);
});
