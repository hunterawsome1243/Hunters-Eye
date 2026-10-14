import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createWhereamiRoute, isPrivate, parseLookup } from '../server/whereami.js';

const source = { id: 'earthquakes', name: 'Earthquakes', intervalMs: 60_000, fetch: async () => ({ quakes: [] }) };
async function serve(opts) {
  const { app, pollers } = createApp([source], { autoStart: false }, { imagery: null, ...opts });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { for (const p of pollers.values()) p.stop(); server.close(); } };
}
const fakeFetch = (calls, body = { success: true, city: 'Denver', region: 'Colorado', country: 'United States', latitude: 39.7392, longitude: -104.9903 }) =>
  async (url) => { calls.push(url); return { ok: true, json: async () => body }; };

test('private and loopback addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', 'fd12::1', '', undefined]) assert.ok(isPrivate(ip), ip);
  for (const ip of ['203.0.113.7', '8.8.8.8', '2001:db8::1', '172.32.0.1']) assert.equal(isPrivate(ip), false, ip);
});

test('parseLookup keeps the coordinates and a readable place, and rejects refusals', () => {
  assert.deepEqual(parseLookup({ success: true, city: 'Denver', region: 'Colorado', country: 'United States', latitude: 39.7, longitude: -104.9 }),
    { lat: 39.7, lon: -104.9, place: 'Denver, Colorado, United States', source: 'ip' });
  assert.deepEqual(parseLookup({ lat: '1.5', lon: '2.5' }).place, '');
  assert.throws(() => parseLookup({ success: false, message: 'Reserved range' }), /Reserved range/);
  assert.throws(() => parseLookup({ city: 'Nowhere' }), /no coordinates/);
});

test('the route looks up the visitor once, caches it, and uses the forwarded address behind a proxy', async () => {
  const calls = [];
  let t = 0;
  const whereami = createWhereamiRoute({ url: 'https://geo.example/{ip}', fetchImpl: fakeFetch(calls), now: () => t });
  const { base, close } = await serve({ whereami, trustProxy: '1' });
  try {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.whereami, true);
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    const first = await (await fetch(`${base}/api/whereami`, { headers })).json();
    assert.equal(first.place, 'Denver, Colorado, United States');
    assert.equal(first.approximate, true);
    await fetch(`${base}/api/whereami`, { headers });
    assert.deepEqual(calls, ['https://geo.example/203.0.113.7']); // the second hit the cache
    t = 2 * 60 * 60_000;
    await fetch(`${base}/api/whereami`, { headers });
    assert.equal(calls.length, 2); // expired after an hour
    await fetch(`${base}/api/whereami`); // loopback: the server's own address is looked up instead
    assert.equal(calls[2], 'https://geo.example/');
  } finally {
    close();
  }
});

test('without a lookup URL the route is off, and a failed lookup is a clear 502', async () => {
  const off = await serve({ whereami: createWhereamiRoute({ url: '' }) });
  try {
    assert.equal((await fetch(`${off.base}/api/config`).then((r) => r.json())).whereami, false);
    assert.equal((await fetch(`${off.base}/api/whereami`)).status, 404);
  } finally {
    off.close();
  }
  const failing = createWhereamiRoute({ url: 'https://geo.example/{ip}', fetchImpl: async () => ({ ok: false, status: 429 }) });
  const { base, close } = await serve({ whereami: failing });
  try {
    const res = await fetch(`${base}/api/whereami`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /HTTP 429/);
  } finally {
    close();
  }
});
