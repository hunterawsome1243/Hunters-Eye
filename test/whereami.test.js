import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { DEFAULT_URL, createWhereamiRoute, fillUrl, isPrivate, parseLookup } from '../server/whereami.js';

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
  // The other services in the default chain
  assert.equal(parseLookup({ latitude: 39.7, longitude: -104.9, city: 'Denver', region: 'Colorado', country_name: 'United States' }).place, 'Denver, Colorado, United States');
  assert.equal(parseLookup({ latitude: 39.7, longitude: -104.9, cityName: 'Denver', regionName: 'Colorado', countryName: 'United States' }).place, 'Denver, Colorado, United States');
  assert.throws(() => parseLookup({ error: true, reason: 'RateLimited' }), /RateLimited/);
});

test('fillUrl puts the address in, and drops its path segment for the server\'s own address', () => {
  assert.equal(fillUrl('https://ipwho.is/{ip}', '203.0.113.7'), 'https://ipwho.is/203.0.113.7');
  assert.equal(fillUrl('https://ipwho.is/{ip}', ''), 'https://ipwho.is/');
  assert.equal(fillUrl('https://ipapi.co/{ip}/json/', ''), 'https://ipapi.co/json/');
  assert.equal(fillUrl('https://freeipapi.com/api/json/{ip}', ''), 'https://freeipapi.com/api/json/');
  assert.equal(DEFAULT_URL.split(',').length, 3);
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
  const calls = [];
  const failing = createWhereamiRoute({ url: 'https://geo.example/{ip}', fetchImpl: async (u) => { calls.push(u); return { ok: false, status: 503 }; } });
  const { base, close } = await serve({ whereami: failing });
  try {
    const res = await fetch(`${base}/api/whereami`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /geo.example: HTTP 503/);
    await fetch(`${base}/api/whereami`);
    assert.equal(calls.length, 1, 'a failure is remembered for a minute, so a reload does not ask again');
  } finally {
    close();
  }
});

test('the chain moves on when a service refuses, and says so when every one is rate-limited', async () => {
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(u);
    if (u.startsWith('https://one.example')) return { ok: false, status: 429 };
    if (u.startsWith('https://two.example')) return { ok: true, json: async () => ({ error: true, reason: 'RateLimited' }) };
    return { ok: true, json: async () => ({ latitude: 39.7, longitude: -104.9, cityName: 'Denver', countryName: 'United States' }) };
  };
  const chain = createWhereamiRoute({ url: 'https://one.example/{ip}, https://two.example/{ip}/json/, https://three.example/api/json/{ip}', fetchImpl });
  assert.equal(chain.urls.length, 3);
  const place = await chain.lookup('203.0.113.7');
  assert.equal(place.place, 'Denver, United States');
  assert.deepEqual(calls, ['https://one.example/203.0.113.7', 'https://two.example/203.0.113.7/json/', 'https://three.example/api/json/203.0.113.7']);

  const limited = createWhereamiRoute({ url: 'https://one.example/{ip},https://two.example/{ip}', fetchImpl: async () => ({ ok: false, status: 429 }) });
  const { base, close } = await serve({ whereami: limited });
  try {
    const body = await (await fetch(`${base}/api/whereami`)).json();
    assert.equal(body.rateLimited, true);
    assert.match(body.error, /rate-limited right now/);
  } finally {
    close();
  }
});

test('a failure is never kept by the browser, so Try again asks the server once its minute is up', async () => {
  let ok = false;
  let t = 0;
  const fetchImpl = async () => (ok ? { ok: true, json: async () => ({ latitude: 51.5, longitude: -0.1, city: 'London' }) } : { ok: false, status: 503 });
  const { base, close } = await serve({ whereami: createWhereamiRoute({ url: 'https://geo.example/{ip}', fetchImpl, now: () => t }) });
  try {
    const failed = await fetch(`${base}/api/whereami`);
    assert.equal(failed.status, 502);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    ok = true;
    t = 61_000;
    const placed = await fetch(`${base}/api/whereami`);
    assert.equal(placed.status, 200);
    assert.equal(placed.headers.get('cache-control'), 'private, max-age=3600');
  } finally {
    close();
  }
});

test('requests for an address already being looked up share that lookup, and fresh lookups are capped a minute', async () => {
  const calls = [];
  let t = 0;
  const fetchImpl = async (u) => {
    calls.push(u);
    await new Promise((r) => setTimeout(r, 30));
    return { ok: true, json: async () => ({ latitude: 39.7, longitude: -104.9, city: 'Denver' }) };
  };
  const route = createWhereamiRoute({ url: 'https://geo.example/{ip}', fetchImpl, now: () => t });
  const same = await Promise.all(Array.from({ length: 30 }, () => route.lookup('203.0.113.7')));
  assert.equal(calls.length, 1);
  assert.ok(same.every((p) => p.place === 'Denver'));
  const many = await Promise.allSettled(Array.from({ length: 70 }, (_, i) => route.lookup(`198.51.100.${i + 1}`)));
  assert.equal(calls.length, 60, 'the first lookup and 59 more this minute');
  const refused = many.filter((r) => r.status === 'rejected');
  assert.equal(refused.length, 11);
  assert.ok(refused.every((r) => r.reason.rateLimited));
  t = 61_000;
  await route.lookup('198.51.100.70'); // refused ones are not remembered as failures
  assert.equal(calls.length, 61);
});
