// Pure helpers of the satellites layer module (the module itself needs a browser).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { epochDate, notableFilter, satFeature } from '../public/js/layers/satellites.js';

test('satFeature marks notables and carries the promoted id', () => {
  const iss = satFeature({ id: '25544', notable: 'ISS' }, { lon: 54.1, lat: 51.4, alt: 419 });
  assert.equal(iss.id, '25544');
  assert.deepEqual(iss.properties, { id: '25544', n: 1, label: 'ISS' });
  assert.deepEqual(iss.geometry, { type: 'Point', coordinates: [54.1, 51.4] });
  const plain = satFeature({ id: '22285' }, { lon: -172.5, lat: 0.3 });
  assert.deepEqual(plain.properties, { id: '22285', n: 0 });
  assert.equal('label' in plain.properties, false);
});

test('notableFilter is off by default and keeps the selected satellite', () => {
  assert.equal(notableFilter(false, '25544'), null);
  assert.deepEqual(notableFilter(true, null), ['any', ['==', ['get', 'n'], 1], ['==', ['get', 'id'], '']]);
  assert.deepEqual(notableFilter(true, '22285'), ['any', ['==', ['get', 'n'], 1], ['==', ['get', 'id'], '22285']]);
});

test('epochDate reads the two-digit TLE year and fractional day', () => {
  assert.equal(epochDate({ epochyr: 26, epochdays: 1 }), Date.UTC(2026, 0, 1));
  assert.equal(epochDate({ epochyr: 26, epochdays: 2.5 }), Date.UTC(2026, 0, 2, 12));
  assert.equal(epochDate({ epochyr: 99, epochdays: 1 }), Date.UTC(1999, 0, 1));
});
