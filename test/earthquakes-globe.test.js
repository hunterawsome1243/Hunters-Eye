import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGE, ageBucket, ageColor, haloFilter, magFilter, quakeFeature, radiusFor } from '../public/js/layers/earthquakes.js';

const HOUR = 3_600_000;
const now = 1_700_000_000_000;

test('age buckets follow the hour / 6 h / day thresholds', () => {
  assert.equal(ageBucket(now - 10 * 60e3, now), 0);
  assert.equal(ageBucket(now - 3 * HOUR, now), 1);
  assert.equal(ageBucket(now - 20 * HOUR, now), 2);
  assert.equal(ageBucket(now - 48 * HOUR, now), 3);
  assert.equal(ageColor(now - 10 * 60e3, now), '#ffcc4d');
  assert.equal(ageColor(now - 48 * HOUR, now), '#8a7a66');
});

test('the paint expression uses the same colours as ageColor', () => {
  // ['match', input, 0, c0, 1, c1, 2, c2, fallback]
  assert.equal(AGE[0], 'match');
  assert.equal(AGE[3], ageColor(now - 1, now));
  assert.equal(AGE[5], ageColor(now - 3 * HOUR, now));
  assert.equal(AGE[7], ageColor(now - 20 * HOUR, now));
  assert.equal(AGE[8], ageColor(now - 48 * HOUR, now));
});

test('quakeFeature carries the promoted id, radius and age in [lon, lat] order', () => {
  const f = quakeFeature({ id: 'us7000aaa1', mag: 5.8, lon: 142.3, lat: 38.1, time: now - 2 * HOUR }, now);
  assert.equal(f.id, 'us7000aaa1');
  assert.equal(f.properties.id, 'us7000aaa1');
  assert.equal(f.properties.mag, 5.8);
  assert.equal(f.properties.r, radiusFor(5.8));
  assert.equal(f.properties.age, 1);
  assert.deepEqual(f.geometry.coordinates, [142.3, 38.1]);
});

test('magnitude filter treats a missing magnitude as very small', () => {
  assert.deepEqual(magFilter(2.5), ['>=', ['coalesce', ['get', 'mag'], -99], 2.5]);
  assert.deepEqual(haloFilter(4), ['all', ['==', ['get', 'age'], 0], magFilter(4)]);
});

test('radiusFor grows with the square of the magnitude and floors at 2.5', () => {
  assert.equal(radiusFor(0), 2.5);
  assert.equal(radiusFor(null), 2.5);
  assert.equal(radiusFor(-1), 2.5);
  assert.equal(radiusFor(4), 2.5 + 8);
});
