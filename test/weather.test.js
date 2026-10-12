import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { simplifyLine } from '../server/lib/geometry.js';
import { startFakeUpstream } from '../scripts/fake-upstream.mjs';

let upstream;
let source;

before(async () => {
  upstream = await startFakeUpstream();
  const base = `http://127.0.0.1:${upstream.address().port}`;
  process.env.NWS_URL = `${base}/nws`;
  process.env.NWS_ZONE_BASE = base;
  process.env.CACHE_DIR = '';
  source = (await import('../server/sources/weather.js')).default;
});

after(() => upstream.close());

test('zone-based alerts get outlines from the zones endpoint; polygon alerts keep their own', async () => {
  const { data, count, note } = await source.fetch();
  assert.equal(count, 4);
  const byEvent = Object.fromEntries(data.alerts.map((a) => [a.event, a]));
  assert.equal(byEvent['Tornado Warning'].polygons.length, 1);
  assert.deepEqual(byEvent['Tornado Warning'].zoneIds, [], 'own polygon wins, no zone lookup');
  assert.deepEqual(byEvent['Excessive Heat Warning'].zoneIds, ['forecast/AZZ537', 'forecast/AZZ553']);
  assert.ok(data.zones['forecast/AZZ537'].length, 'outline included once');
  assert.equal(data.zones['county/OKC109'], undefined, 'zones nobody needs are not sent');
  assert.deepEqual(byEvent['Small Craft Advisory'].zoneIds, [], 'missing zone does not fail the feed');
  assert.match(note, /1 alerts have no outline/);
  assert.equal(byEvent['Tornado Warning'].severity, 'Extreme');
  assert.ok(byEvent['Tornado Warning'].sent < Date.now());
});

test('simplifyLine drops near-collinear points but keeps rings valid', () => {
  const line = [[0, 0], [1, 0.0001], [2, 0], [2, 2], [0, 2], [0, 0]];
  const out = simplifyLine(line, 0.01);
  assert.ok(out.length < line.length);
  assert.ok(out.length >= 4);
  assert.deepEqual(out[0], out[out.length - 1]);
});
