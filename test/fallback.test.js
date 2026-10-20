import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { routes } from '../scripts/fake-upstream.mjs';
import { aircraftSource, createFallbacks, satellitesSource } from '../public/js/fallback.js';

const HOUR = 3_600_000;

function memoryStore() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
}

// A fetch stand-in that answers from the fake upstream handlers and records calls.
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return answer(url, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const celestrakOk = (url) => new Response(routes['/celestrak']({ url: new URL(url).pathname + new URL(url).search }));
const openskyOk = (url) => Response.json(routes['/opensky/states/all']({ url: new URL(url).pathname + new URL(url).search }));
const corsBlocked = () => Promise.reject(new TypeError('Failed to fetch'));

test('satellites fallback downloads each group once per 2-hour update and keeps the cache on 403', async () => {
  let t = Date.UTC(2026, 9, 12, 12);
  const store = memoryStore();
  let mode = 'ok';
  const fetch = fakeFetch((url) => (mode === 'ok' ? celestrakOk(url) : new Response('no new data', { status: 403 })));
  const src = satellitesSource('https://celestrak.test/gp.php', { fetch, store, now: () => t });

  const first = await src.fetch();
  assert.equal(fetch.calls.length, 2);
  assert.match(fetch.calls[0], /GROUP=STATIONS&FORMAT=TLE$/);
  assert.ok(first.data.satellites.some((s) => s.notable === 'ISS'));
  assert.equal(first.updatedAt, t);
  assert.ok(first.nextDelayMs >= 2 * HOUR - 60_000);

  t += HOUR; // inside the 2-hour window: served from the cache
  await src.fetch();
  assert.equal(fetch.calls.length, 2);

  // A new page load reads the same localStorage cache.
  const reloaded = satellitesSource('https://celestrak.test/gp.php', { fetch, store, now: () => t });
  assert.equal((await reloaded.fetch()).count, first.count);
  assert.equal(fetch.calls.length, 2);

  t += 1.5 * HOUR; // past the window, and CelesTrak says "nothing newer"
  mode = '403';
  const after403 = await src.fetch();
  assert.equal(fetch.calls.length, 4);
  assert.equal(after403.count, first.count);
  assert.doesNotMatch(after403.note, /cached data/);
  assert.equal(after403.updatedAt, first.updatedAt); // still the real download time
});

test('satellites fallback without a cache reports the failure and retries no sooner than 10 minutes', async () => {
  let t = Date.UTC(2026, 9, 12, 12);
  const fetch = fakeFetch(corsBlocked);
  const src = satellitesSource('https://celestrak.test/gp.php', { fetch, store: memoryStore(), now: () => t });
  await assert.rejects(src.fetch(), /^Error: refused or unreachable \(the site may not accept requests from other web pages\)$/);
  assert.equal(fetch.calls.length, 2);
  t += 5 * 60_000;
  await assert.rejects(src.fetch());
  assert.equal(fetch.calls.length, 2);
  t += 6 * 60_000;
  await assert.rejects(src.fetch());
  assert.equal(fetch.calls.length, 4);
});

test('aircraft fallback queries the view box and spaces requests on the anonymous budget', async () => {
  let t = Date.UTC(2026, 9, 12, 12);
  const store = memoryStore();
  const fetch = fakeFetch(openskyOk);
  let bbox = { lamin: 45, lomin: 5, lamax: 47, lomax: 9 };
  const src = aircraftSource('https://opensky.test/api', { fetch, store, now: () => t, options: () => ({ bbox }) });

  assert.equal(src.deferMs(false), 0);
  const r = await src.fetch();
  assert.match(fetch.calls[0], /^https:\/\/opensky\.test\/api\/states\/all\?extended=1&lamin=44\.7&lomin=4\.4&lamax=47\.3&lomax=9\.6$/);
  assert.ok(r.count > 0);
  assert.deepEqual(r.data.bbox, { lamin: 44.7, lomin: 4.4, lamax: 47.3, lomax: 9.6 });
  assert.match(r.note, /^Covers the map view\./);
  assert.equal(r.nextDelayMs, Math.ceil((86_400_000 / 400) * 1.15)); // 1 credit

  // A reloaded page waits a minute; a page that has data waits for the next slot.
  assert.equal(src.deferMs(false), 60_000);
  assert.equal(src.deferMs(true), r.nextDelayMs);

  bbox = null;
  t += 120_000;
  const world = await src.fetch();
  assert.match(fetch.calls[1], /states\/all\?extended=1$/);
  assert.match(world.note, /^Covers the whole world\./);
  assert.equal(world.nextDelayMs, Math.ceil(((4 * 86_400_000) / 400) * 1.15)); // ~17 min
});

test('aircraft fallback backs off for an hour on 429, also across reloads', async () => {
  const t = Date.UTC(2026, 9, 12, 12);
  const store = memoryStore();
  const fetch = fakeFetch(() => new Response('', { status: 429 }));
  const src = aircraftSource('https://opensky.test/api', { fetch, store, now: () => t, options: () => ({}) });
  await assert.rejects(src.fetch(), (err) => err.retryAfterMs === HOUR && /credit limit/.test(err.message));
  const reloaded = aircraftSource('https://opensky.test/api', { fetch, store, now: () => t + 1000, options: () => ({}) });
  assert.equal(reloaded.deferMs(false), HOUR - 1000);
});

test('a browser fallback held off by a back-off says it will try, not that it is trying', async () => {
  const t = Date.now();
  const store = memoryStore();
  const fetch = fakeFetch(() => new Response('', { status: 429 }));
  await assert.rejects(aircraftSource('https://opensky.test/api', { fetch, store, now: () => t, options: () => ({}) }).fetch());
  const fb = createFallbacks({ aircraft: 'https://opensky.test/api' }, { onData: () => assert.fail('no fetch expected'), fetch, store }); // a reload
  const failed = { id: 'aircraft', ok: false, loading: false, error: 'timed out', note: null, count: 0, updatedAt: null, nextAt: null, intervalMs: 1000 };
  fb.status(failed);
  await sleep(20);
  const shown = fb.status(failed);
  assert.equal(fetch.calls.length, 1);
  assert.equal(shown.waiting, true);
  assert.equal(shown.note, "Your browser will try because the server can't reach OpenSky (timed out).");
  fb.stop();
});

test('createFallbacks stands in only while the server has failed with no data', async () => {
  const received = [];
  let changes = 0;
  const fb = createFallbacks(
    { aircraft: 'https://opensky.test/api', satellites: 'https://celestrak.test/gp.php' },
    { onData: (id, data) => received.push([id, data]), onChange: () => changes++, fetch: fakeFetch(openskyOk), store: memoryStore() },
  );
  const base = { id: 'aircraft', ok: false, loading: false, error: null, note: null, count: 0, updatedAt: null, nextAt: null, intervalMs: 1000 };

  // Still loading on the server: nothing to do yet.
  assert.equal(fb.status({ ...base, loading: true }).via, undefined);
  // Server has data: always the server's status.
  const serverOk = { ...base, ok: true, updatedAt: 1, count: 5 };
  assert.equal(fb.status(serverOk), serverOk);
  // Unknown sources pass through.
  const quakes = { ...base, id: 'earthquakes', error: 'boom' };
  assert.equal(fb.status(quakes), quakes);

  // Server failed with no data: the browser fetches and reports its own status.
  const failed = { ...base, error: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)' };
  const loading = fb.status(failed);
  assert.equal(loading.via, 'browser');
  assert.equal(loading.loading, true);
  assert.match(loading.note, /^Your browser is trying because the server can't reach OpenSky/); // nothing loaded yet
  await sleep(20);
  assert.equal(received.length, 1);
  assert.equal(received[0][0], 'aircraft');
  assert.ok(received[0][1].states.length > 0);
  assert.equal(changes, 1);
  const shown = fb.status(failed);
  assert.equal(shown.ok, true);
  assert.equal(shown.error, null);
  assert.equal(shown.count, received[0][1].states.length);
  assert.match(shown.note, /Loaded by your browser because the server can't reach OpenSky \(fetch failed \(UND_ERR_CONNECT_TIMEOUT\)\)\./);

  // The server recovers: back to its status, and the browser stops.
  assert.equal(fb.status(serverOk), serverOk);
  fb.stop();
});

test('createFallbacks says plainly when the browser is blocked too', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const fb = createFallbacks({ satellites: 'https://celestrak.test/gp.php' }, { onData: () => assert.fail('no data expected'), fetch: fakeFetch(corsBlocked), store: memoryStore() });
    const failed = { id: 'satellites', ok: false, loading: false, error: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)', count: 0, updatedAt: null, intervalMs: 1000 };
    fb.status(failed);
    await sleep(20);
    const shown = fb.status(failed);
    assert.equal(shown.ok, false);
    assert.equal(shown.loading, false);
    assert.match(shown.error, /^The server can't reach CelesTrak, and your browser's request failed too: refused or unreachable/);
    assert.equal(shown.note, "Your browser tried because the server can't reach CelesTrak (fetch failed (UND_ERR_CONNECT_TIMEOUT)).");
    assert.ok(shown.nextAt > Date.now() + 9 * 60_000);
    fb.stop();
  } finally {
    console.warn = warn;
  }
});

test('a hidden tab\'s browser fallback waits for the page to wake instead of spending credits', async () => {
  let awake = false;
  const received = [];
  const fetchFn = fakeFetch(celestrakOk);
  const fb = createFallbacks({ satellites: 'https://celestrak.test/gp.php' }, { onData: (id, data) => received.push(id), fetch: fetchFn, store: memoryStore(), awake: () => awake });
  const failed = { id: 'satellites', ok: false, loading: false, error: 'timed out', note: null, count: 0, updatedAt: null, nextAt: null, intervalMs: 1000 };
  fb.status(failed);
  await sleep(20);
  assert.equal(fetchFn.calls.length, 0, 'nothing fetched while asleep');
  fb.wake(); // still asleep: stays parked
  await sleep(20);
  assert.equal(fetchFn.calls.length, 0);
  awake = true;
  fb.wake();
  await sleep(50);
  assert.ok(fetchFn.calls.length > 0, 'fetched once awake');
  assert.deepEqual(received, ['satellites']);
  fb.stop();
});
