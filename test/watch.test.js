import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRule, matches } from '../public/js/ui/watch.js';

const denver = { lat: 39.7392, lon: -104.9903 };
const tornado = { id: 'weather:1', title: 'Tornado Warning', subtitle: 'Oklahoma County, OK', latlng: [35.5, -97.4] };
const quake = { id: 'earthquakes:1', title: 'M 6.1 earthquake', subtitle: '95 km E of Namie, Japan · 35 km deep', latlng: [38.1, 142.3], mag: 6.1 };
const plane = { id: 'aircraft:abc', title: 'UAL123 squawking 7700', subtitle: 'General emergency · United States', latlng: [40.2, -105.1] };

test('a keyword rule matches the title or subtitle, case-insensitively', () => {
  assert.ok(matches({ keyword: 'tornado' }, tornado));
  assert.ok(matches({ keyword: 'oklahoma county' }, tornado));
  assert.ok(matches({ keyword: 'm 6' }, quake));
  assert.ok(matches({ keyword: '7700' }, plane));
  assert.equal(matches({ keyword: 'tornado' }, quake), false);
  assert.equal(matches({ keyword: '' }, quake), false);
  assert.equal(matches({ keyword: 'tornado' }, { ...tornado, system: true }), false);
});

test('a keyword like "M6" is a magnitude: that or stronger, written any way', () => {
  for (const keyword of ['M6', 'm6', 'M 6', 'M6+', 'M6.1', 'm 6.0']) assert.ok(matches({ keyword }, quake), keyword);
  assert.ok(matches({ keyword: 'M6' }, { ...quake, title: 'M 7.4 earthquake', mag: 7.4 }));
  assert.equal(matches({ keyword: 'M6' }, { ...quake, title: 'M 5.9 earthquake', mag: 5.9 }), false);
  assert.equal(matches({ keyword: 'M6.5' }, quake), false);
  assert.equal(matches({ keyword: 'M6' }, tornado), false);
  // Without a magnitude on the entry the keyword is plain text again.
  assert.ok(matches({ keyword: 'M6' }, { ...quake, mag: undefined }));
  assert.ok(matches({ keyword: 'M6.1 earthquake' }, quake));
});

test('a distance rule needs the marker and measures from it', () => {
  assert.equal(matches({ km: 1000 }, tornado, null), false);
  assert.ok(matches({ km: 1000 }, tornado, denver)); // Oklahoma City is about 800 km from Denver
  assert.equal(matches({ km: 500 }, tornado, denver), false);
  assert.ok(matches({ km: 100 }, plane, denver));
  assert.equal(matches({ km: 100 }, { ...plane, latlng: null }, denver), false);
  assert.ok(matches({ keyword: '7700', km: 100 }, plane, denver));
  assert.equal(matches({ keyword: 'tornado', km: 100 }, plane, denver), false);
});

test('rules read back in plain words', () => {
  assert.equal(describeRule({ keyword: 'Tornado', km: 0 }), '“Tornado”');
  assert.equal(describeRule({ keyword: '', km: 250 }), 'within 250 km of you');
  assert.equal(describeRule({ keyword: 'M6', km: 1500 }), '“M6” within 1,500 km of you');
});
