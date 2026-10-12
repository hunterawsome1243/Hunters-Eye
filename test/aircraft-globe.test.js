import assert from 'node:assert/strict';
import { test } from 'node:test';
import { altitudeColor, boxInside, intervalFor, planeFeature, position } from '../public/js/layers/aircraft.js';

const plane = { icao24: 'abc123', lat: 50, lon: 8, velocity: 250, track: 90, timePosition: 1_700_000_000, altitude: 10_500, onGround: false, squawk: '7700' };

test('dead reckoning moves along the heading on the server clock and caps the age', () => {
  const t0 = 1_700_000_000_000;
  assert.deepEqual(position(plane, t0), [50, 8]);
  const [lat, lon] = position(plane, t0 + 60_000);
  assert.ok(Math.abs(lat - 50) < 1e-9, 'due east keeps the latitude');
  assert.ok(lon > 8.2 && lon < 8.22, `60 s at 250 m/s eastward ≈ 0.21° at 50°N, got ${lon}`);
  // A skewed browser clock is corrected by the offset.
  assert.deepEqual(position(plane, t0 - 60_000, 60_000), [50, 8]);
  // Nothing extrapolates past five minutes.
  assert.deepEqual(position(plane, t0 + 3_600_000), position(plane, t0 + 300_000));
  assert.deepEqual(position({ ...plane, onGround: true }, t0 + 60_000), [50, 8]);
  assert.deepEqual(position({ ...plane, track: null }, t0 + 60_000), [50, 8]);
});

test('plane features are tiny, keyed by icao24, with [lon, lat] coordinates', () => {
  const f = planeFeature(plane, 51, 9);
  assert.equal(f.id, 'abc123');
  assert.deepEqual(f.geometry, { type: 'Point', coordinates: [9, 51] });
  assert.deepEqual(f.properties, { icao24: 'abc123', t: 90, a: 10_500, g: 0, em: 1 });
  const g = planeFeature({ ...plane, onGround: true, track: null, squawk: '1200' }, 51, 9);
  assert.deepEqual(g.properties, { icao24: 'abc123', t: 0, a: 10_500, g: 1, em: 0 });
});

test('dead-reckoning cadence follows the zoom and doubles on phones', () => {
  assert.equal(intervalFor(1.8), 0);
  assert.equal(intervalFor(2.99), 0);
  assert.equal(intervalFor(3), 12_000);
  assert.equal(intervalFor(5.99), 12_000);
  assert.equal(intervalFor(6), 5000);
  assert.equal(intervalFor(9.99), 5000);
  assert.equal(intervalFor(10), 2000);
  assert.equal(intervalFor(12.99), 2000);
  assert.equal(intervalFor(13), 1000);
  assert.equal(intervalFor(13, true), 2000);
  assert.equal(intervalFor(7, true), 10_000);
  assert.equal(intervalFor(1, true), 0);
});

test('altitude colours match the paint buckets', () => {
  assert.equal(altitudeColor({ onGround: true, altitude: 12_000 }), '#6b7280');
  assert.equal(altitudeColor({ altitude: null }), '#5eead4');
  assert.equal(altitudeColor({ altitude: 2999 }), '#5eead4');
  assert.equal(altitudeColor({ altitude: 3000 }), '#38bdf8');
  assert.equal(altitudeColor({ altitude: 7000 }), '#a5b4fc');
  assert.equal(altitudeColor({ altitude: 10_000 }), '#e0f2fe');
});

test('boxInside says whether a view still sits inside the padded push box', () => {
  const pushed = { lamin: 40, lamax: 50, lomin: 0, lomax: 20 };
  assert.ok(boxInside({ lamin: 42, lamax: 48, lomin: 5, lomax: 15 }, pushed));
  assert.ok(boxInside(pushed, pushed));
  assert.ok(!boxInside({ lamin: 42, lamax: 51, lomin: 5, lomax: 15 }, pushed));
  assert.ok(!boxInside({ lamin: 42, lamax: 48, lomin: -1, lomax: 15 }, pushed));
});
