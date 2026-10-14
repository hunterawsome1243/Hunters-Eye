import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearest } from '../public/js/ui/near.js';

const you = { lat: 39.74, lon: -104.99 }; // Denver
const entries = [
  { id: 'a', title: 'Far quake', latlng: [35.68, 139.69], time: 5 },
  { id: 'b', title: 'Boulder', latlng: [40.01, -105.27], time: 4 },
  { id: 'c', title: 'No position', latlng: null, time: 3 },
  { id: 'd', title: 'System row', system: true, latlng: [39.74, -104.99], time: 2 },
  { id: 'e', title: 'Kansas City', latlng: [39.10, -94.58], time: 1 },
];

test('nearest orders positioned entries by distance from you and labels each', () => {
  const near = nearest(entries, you);
  assert.deepEqual(near.map((e) => e.id), ['b', 'e', 'a']);
  assert.ok(near[0].km > 30 && near[0].km < 50, `Boulder is ${near[0].km} km`);
  assert.equal(near[0].dir, 'NW');
  assert.equal(near[1].dir, 'E');
  assert.deepEqual(nearest(entries, you, 1).map((e) => e.id), ['b']);
});

test('without a place the proximity feed is empty', () => {
  assert.deepEqual(nearest(entries, null), []);
});
