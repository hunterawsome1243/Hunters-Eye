import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { STEPS, createOverlaysRoute, fetchOrder, gridPoints, gridSpec, parseBatch } from '../server/overlays.js';
import { HttpError } from '../server/lib/http.js';
import { RAMPS, colorAt, compass, convert, formatValue, latOfRow, localUnits, nearestIndex, nightPolygon, paintField, probe, rampCss, sample, subsolarPoint, unitLabel } from '../public/js/overlays/field.js';
import { firesDay, serverOut } from '../public/js/ui/overlays.js';
import { backoffMs, createGridLoader, describeError, limitHit } from '../shared/openmeteo.js';

const source = { id: 'earthquakes', name: 'Earthquakes', intervalMs: 60_000, fetch: async () => ({ quakes: [] }) };
async function serve(opts) {
  const { app, pollers } = createApp([source], { autoStart: false }, { imagery: null, ...opts });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { for (const p of pollers.values()) p.stop(); server.close(); } };
}
// Answers like Open-Meteo: one object per point asked for, temperature = latitude.
const fakeJson = (calls) => async (url) => {
  calls.push(url);
  const q = new URL(url).searchParams;
  const lats = q.get('latitude').split(',').map(Number);
  const lons = q.get('longitude').split(',').map(Number);
  return lats.map((lat, i) => ({ latitude: lat, longitude: lons[i], current: { temperature_2m: lat, wind_speed_10m: 10, wind_direction_10m: 90, precipitation: 0.5, cloud_cover: 40 } }));
};

test('the grid runs 80°S to 80°N in rows, west to east in columns', () => {
  const g = gridSpec(10);
  assert.deepEqual(g, { lat0: -80, lon0: -180, step: 10, rows: 17, cols: 36 });
  const pts = gridPoints(g);
  assert.equal(pts.length, 612);
  assert.deepEqual(pts[0], [-80, -180]);
  assert.deepEqual(pts[36], [-70, -180]);
  assert.deepEqual(pts.at(-1), [80, 170]);
  assert.equal(gridSpec('abc').step, 10);
  assert.equal(gridSpec(1).step, 5, 'never finer than 5°');
  assert.equal(gridSpec(7).step, 7.5, 'snaps to a spacing that closes round the planet');
  assert.equal(gridSpec(100).step, 30);
  for (const s of STEPS) {
    const g = gridSpec(s);
    assert.equal(g.cols * g.step, 360, `${s}° columns meet the first`);
    assert.equal(gridPoints(g).length, g.rows * g.cols);
  }
});

test('parseBatch takes one point or many and refuses a short or refused answer', () => {
  assert.deepEqual(parseBatch({ current: { temperature_2m: 3, wind_speed_10m: 1, wind_direction_10m: 2, precipitation: 0, cloud_cover: 'n/a' } }, 1),
    [{ temperature: 3, wind: 1, windDir: 2, rain: 0, clouds: null }]);
  assert.equal(parseBatch([{ current: {} }, { current: {} }], 2).length, 2);
  assert.throws(() => parseBatch([{ current: {} }], 2), /1 of 2/);
  assert.throws(() => parseBatch({ error: true, reason: 'Too many' }, 1), /Too many/);
});

test('the points go out equator first, so the first wave covers where people look', () => {
  const pts = gridPoints(gridSpec(10));
  const order = fetchOrder(pts);
  assert.equal(order.length, 612);
  assert.equal(new Set(order).size, 612, 'every point once');
  assert.equal(pts[order[0]][0], 0, 'the equator row leads');
  assert.ok(order.slice(0, 396).every((i) => Math.abs(pts[i][0]) <= 50), '50°S to 50°N is 396 points, all in the first wave');
  assert.ok(order.slice(400).every((i) => Math.abs(pts[i][0]) >= 60), 'the rest of the 60° rows and the poles come in the second wave');
  assert.equal(Math.abs(pts[order.at(-1)][0]), 80);
});

test('the route fetches the grid in waves of 400 points a minute, serves what has arrived, refreshes when stale', async () => {
  const calls = [];
  let t = 1_000_000;
  const route = createOverlaysRoute({ url: 'https://meteo.test/v1/forecast', fetchJson: fakeJson(calls), now: () => t, refreshMin: '120' });
  assert.ok(route.enabled);
  const { base, close } = await serve({ overlays: route });
  const get = async () => { const res = await fetch(`${base}/api/overlays/weather`); return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() }; };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  try {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(config.overlays, { weather: true, browser: { url: 'https://api.open-meteo.com/v1/forecast', gridDeg: 10, refreshMin: 120 } });
    const first = await get();
    assert.equal(first.status, 200);
    assert.equal(calls.length, 4, '400 points, 100 a request, one request at a time, in the first wave');
    assert.ok(calls.every((u, i) => i === 0 || calls.indexOf(u) === i), 'each batch once');
    assert.ok(decodeURIComponent(calls[0]).startsWith('https://meteo.test/v1/forecast?latitude=0,0'));
    assert.ok(decodeURIComponent(calls[0]).includes('current=temperature_2m,wind_speed_10m'));
    const d = first.body;
    assert.equal(d.partial, true);
    assert.equal(d.done, 400);
    assert.equal(d.total, 612);
    assert.equal(first.cache, 'no-store', 'a partial grid is not cached');
    assert.equal(d.fields.temperature.length, 612);
    assert.equal(d.fields.temperature[8 * 36], 0, 'the equator row is in');
    assert.equal(d.fields.temperature[0], null, 'the 80°S row is not yet');
    assert.equal(d.units.temperature, '°C');
    assert.equal(d.refreshMs, 120 * 60_000);
    assert.equal(d.stale, false);
    assert.equal(d.error, null);
    await get();
    assert.equal(calls.length, 4, 'the second wave waits a minute');
    t += 61_000;
    const mid = (await get()).body;
    assert.ok(mid.done >= 400 && mid.partial, `what has arrived (${mid.done}) goes out while the wave runs`);
    await settle();
    assert.equal(calls.length, 7, '212 points: 100, 100, 12');
    const whole = (await get()).body;
    assert.equal(whole.partial, false);
    assert.equal(whole.done, 612);
    assert.equal(whole.fields.temperature[0], -80);
    assert.equal(whole.fields.temperature.at(-1), 80);
    assert.equal(whole.at, 1_000_000);
    assert.equal(whole.updated, t);
    await get();
    assert.equal(calls.length, 7, 'served from memory');
    t += 121 * 60_000;
    const refreshStart = t;
    const again = (await get()).body;
    assert.equal(again.at, 1_000_000, 'the old grid is served while the refresh runs');
    assert.equal(again.stale, true);
    await settle();
    assert.equal(calls.length, 11, 'the replacement starts with a wave of its own');
    assert.equal((await get()).body.at, 1_000_000, 'and is not served until it is complete');
    t += 61_000;
    await get();
    await settle();
    assert.equal(calls.length, 14);
    const fresh = (await get()).body;
    assert.equal(fresh.at, refreshStart);
    assert.equal(fresh.partial, false);
    assert.equal(fresh.stale, false);
  } finally {
    close();
  }
});

test('a partial grid nobody asked to finish is started over once it is old', async () => {
  const calls = [];
  let t = 7_000_000;
  const route = createOverlaysRoute({ url: 'https://meteo.test', fetchJson: fakeJson(calls), now: () => t });
  const { base, close } = await serve({ overlays: route });
  try {
    assert.equal((await (await fetch(`${base}/api/overlays/weather`)).json()).done, 400);
    t += 3 * 3600_000;
    const d = await (await fetch(`${base}/api/overlays/weather`)).json();
    assert.equal(calls.length, 8, 'a new first wave, not the old grid\'s second');
    assert.equal(d.at, t);
    assert.equal(d.done, 400);
  } finally {
    close();
  }
});

test('a failed grid is a 502 the first time, kept stale after, and not retried for a minute', async () => {
  let fail = true;
  let t = 5_000_000;
  const calls = [];
  const fetchJson = async (url) => { calls.push(url); if (fail) throw new Error('api.open-meteo.com: timed out'); return fakeJson([])(url); };
  const route = createOverlaysRoute({ url: 'https://meteo.test', fetchJson, now: () => t });
  const { base, close } = await serve({ overlays: route });
  try {
    const res = await fetch(`${base}/api/overlays/weather`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /timed out/);
    assert.equal(calls.length, 1, 'the first request fails and the rest of the wave is not sent');
    assert.equal((await fetch(`${base}/api/overlays/weather`)).status, 502);
    assert.equal(calls.length, 1, 'not retried within a minute');
    fail = false;
    t += 61_000;
    const partial = await fetch(`${base}/api/overlays/weather`);
    assert.equal(partial.status, 200);
    assert.equal((await partial.json()).done, 400);
    t += 61_000;
    await fetch(`${base}/api/overlays/weather`);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 8, 'the second wave completes the grid');
    assert.equal((await (await fetch(`${base}/api/overlays/weather`)).json()).partial, false);
    fail = true;
    t += 3 * 3600_000;
    const stale = await (await fetch(`${base}/api/overlays/weather`)).json();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stale.stale, true);
    const after = await (await fetch(`${base}/api/overlays/weather`)).json();
    assert.match(after.error, /timed out/);
    assert.equal(after.fields.temperature.length, 612, 'the last grid is kept');
    assert.equal(after.fields.temperature[0], -80, 'whole, not the failed replacement');
  } finally {
    close();
  }
});

test('a 429 with Retry-After is honoured: no further requests until it has passed', async () => {
  let t = 9_000_000;
  const calls = [];
  const fetchJson = async (url) => { calls.push(url); throw new HttpError(429, 'api.open-meteo.com answered HTTP 429', 3_600_000); };
  const route = createOverlaysRoute({ url: 'https://meteo.test', fetchJson, now: () => t });
  const { base, close } = await serve({ overlays: route });
  try {
    assert.equal((await fetch(`${base}/api/overlays/weather`)).status, 502);
    assert.equal(calls.length, 1);
    t += 10 * 60_000;
    assert.equal((await fetch(`${base}/api/overlays/weather`)).status, 502);
    assert.equal(calls.length, 1, 'left alone while Retry-After runs');
    t += 51 * 60_000;
    await fetch(`${base}/api/overlays/weather`);
    assert.equal(calls.length, 2, 'tried again once the hour has passed');
  } finally {
    close();
  }
});

test('a 429 names the limit it hit, and the wait follows the limit', () => {
  const daily = new HttpError(429, 'api.open-meteo.com answered HTTP 429: {"reason":"Daily API request limit exceeded. Please try again tomorrow.","error":true}');
  const hourly = new HttpError(429, 'api.open-meteo.com answered HTTP 429: {"error":true,"reason":"Hourly API request limit exceeded. Please try again in the next hour."}');
  const minutely = new HttpError(429, 'api.open-meteo.com answered HTTP 429: {"error":true,"reason":"Minutely API request limit exceeded. Please try again in one minute."}');
  const other = new HttpError(502, 'api.open-meteo.com answered HTTP 502');
  assert.equal(limitHit(daily), 'daily');
  assert.equal(limitHit(hourly), 'hourly');
  assert.equal(limitHit(minutely), 'minutely');
  assert.equal(limitHit(other), null, 'only a 429 names a limit');
  assert.equal(limitHit({ message: 'Daily API request limit exceeded' }), 'daily', 'a browser error without a status counts too');
  assert.equal(limitHit(new Error('timed out')), null);
  const now = Date.UTC(2026, 9, 15, 13, 20, 41);
  assert.equal(backoffMs(daily, now), 3_600_000, 'the day is asked about again in an hour, not trusted to reset at midnight');
  assert.equal(backoffMs(hourly, now), (60 - 20) * 60_000 - 41_000 + 60_000, 'until a minute past the top of the hour');
  assert.equal(backoffMs(minutely, now), 61_000);
  assert.equal(backoffMs(other, now), 60_000);
  assert.equal(backoffMs(new HttpError(429, 'x', 2 * 3_600_000), now), 2 * 3_600_000, 'Retry-After wins when longer');
  assert.match(describeError(daily), /daily allowance .* try again tomorrow/);
  assert.match(describeError(hourly), /hourly allowance/);
  assert.match(describeError(minutely), /600 points a minute/);
  assert.equal(describeError(other), 'api.open-meteo.com answered HTTP 502');
  assert.equal(describeError(new HttpError(503, 'api.open-meteo.com answered HTTP 503: {"error":true,"reason":"Too many concurrent requests"}')), 'Open-Meteo refused the request: Too many concurrent requests', 'the reason, not the JSON');
  assert.equal(describeError(new HttpError(400, 'api.open-meteo.com answered HTTP 400: {"error":true}')), 'api.open-meteo.com answered HTTP 400', 'JSON without a reason is dropped');
  assert.equal(describeError(new HttpError(500, 'api.open-meteo.com answered HTTP 500: Internal Server Error')), 'api.open-meteo.com answered HTTP 500: Internal Server Error', 'plain text stays');
});

test('only a whole, fresh, untroubled grid is cached, and only until it is stale', async () => {
  let t = 6_000_000;
  let fail = false;
  const calls = [];
  const fetchJson = async (url) => { if (fail) throw new Error('api.open-meteo.com: timed out'); return fakeJson(calls)(url); };
  const route = createOverlaysRoute({ url: 'https://meteo.test', fetchJson, now: () => t, refreshMin: 120 });
  const { base, close } = await serve({ overlays: route });
  const get = async () => { const res = await fetch(`${base}/api/overlays/weather`); return { cache: res.headers.get('cache-control'), body: await res.json() }; };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  try {
    assert.equal((await get()).cache, 'no-store', 'a partial grid');
    t += 61_000;
    await get();
    await settle();
    assert.equal((await get()).cache, 'public, max-age=300', 'whole and fresh');
    t = 6_000_000 + 120 * 60_000 - 100_000;
    assert.equal((await get()).cache, 'public, max-age=100', 'no longer than it stays fresh');
    t = 6_000_000 + 121 * 60_000;
    fail = true;
    const stale = await get();
    await settle();
    assert.equal(stale.body.stale, true);
    assert.equal(stale.cache, 'no-store', 'a stale grid: a browser must see the server\'s current state to decide whether to fetch for itself');
    const troubled = await get();
    assert.match(troubled.body.error, /timed out/);
    assert.equal(troubled.cache, 'no-store', 'a grid whose refresh failed');
  } finally {
    close();
  }
});

test('a replacement whose first wave failed is started afresh, so the new grid is not born stale', async () => {
  let t = 4_000_000;
  let fail = false;
  const calls = [];
  const fetchJson = async (url) => { if (fail) throw new Error('api.open-meteo.com: timed out'); return fakeJson(calls)(url); };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const loader = createGridLoader({ url: 'https://meteo.test', now: () => t, fetchJson });
  await loader.current();
  t += 61_000;
  await loader.current();
  await settle();
  assert.equal((await loader.current()).partial, false);
  t += 121 * 60_000;
  const firstTry = t;
  fail = true;
  assert.equal((await loader.current()).at, 4_000_000, 'the old grid goes out while the replacement\'s first wave fails');
  await settle();
  assert.match(loader.lastError.message, /timed out/);
  fail = false;
  t += 61_000;
  const restart = t;
  await loader.current();
  await settle();
  t += 61_000;
  await loader.current();
  await settle();
  const fresh = await loader.current();
  assert.equal(fresh.partial, false);
  assert.equal(fresh.at, restart, 'dated from the wave that succeeded');
  assert.notEqual(fresh.at, firstTry);
  assert.equal(calls.length, 14);
});

test('the browser keeps its grid in storage: a reload or a second tab starts from it instead of buying it again', async () => {
  let t = 2_000_000;
  let stored = null;
  const store = { load: () => (stored ? JSON.parse(stored) : null), save: (g) => { stored = JSON.stringify(g); } };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const opts = { url: 'https://meteo.test', refreshMin: 120, now: () => t, store };
  const callsA = [];
  const callsB = [];
  const a = createGridLoader({ ...opts, fetchJson: fakeJson(callsA) });
  const b = createGridLoader({ ...opts, fetchJson: fakeJson(callsB) });
  assert.equal((await a.current()).done, 400);
  assert.equal(callsA.length, 4);
  assert.ok(stored, 'the first wave is kept');
  assert.equal((await b.current()).done, 400, 'the second tab starts from the first tab\'s wave');
  assert.equal(callsB.length, 0, 'and buys nothing');
  t += 61_000;
  await b.current();
  await settle();
  assert.equal(callsB.length, 3, 'the second tab fetches the second wave');
  assert.equal(callsA.length, 4, 'the first does not');
  assert.equal((await b.current()).partial, false);
  const aWhole = await a.current();
  assert.equal(aWhole.partial, false, 'the first tab adopts the whole grid');
  assert.equal(aWhole.fields.temperature[0], -80);
  assert.equal(callsA.length, 4, 'without fetching');
  const callsC = [];
  const c = createGridLoader({ ...opts, fetchJson: fakeJson(callsC) });
  assert.equal((await c.current()).partial, false, 'a reload starts from the stored grid');
  assert.equal(callsC.length, 0);
  t += 121 * 60_000;
  const callsD = [];
  const d = createGridLoader({ ...opts, fetchJson: fakeJson(callsD) });
  assert.equal((await d.current()).at, t, 'a stored grid older than the refresh is not adopted');
  assert.equal(callsD.length, 4);
  stored = JSON.stringify({ step: 10, total: 612, at: t, updated: t, done: 612, fields: { temperature: [] } });
  const callsE = [];
  const e = createGridLoader({ ...opts, fetchJson: fakeJson(callsE) });
  assert.equal((await e.current()).done, 400, 'a malformed stored grid is ignored');
  assert.equal(callsE.length, 4);
});

test('a refusal is shared through storage too: a second tab waits out the limit instead of asking again', async () => {
  let t = 3_000_000;
  let stored = null;
  const store = { load: () => (stored ? JSON.parse(stored) : null), save: (g) => { stored = JSON.stringify(g); } };
  const calls = [];
  const fetchJson = async (url) => { calls.push(url); throw new HttpError(429, 'api.open-meteo.com answered HTTP 429: {"reason":"Daily API request limit exceeded. Please try again tomorrow.","error":true}'); };
  const a = createGridLoader({ url: 'https://meteo.test', now: () => t, store, fetchJson });
  await assert.rejects(a.current(), /Daily API request limit/);
  assert.equal(calls.length, 1);
  assert.equal(a.retryInMs(), 3_600_000);
  const b = createGridLoader({ url: 'https://meteo.test', now: () => t, store, fetchJson });
  await assert.rejects(b.current(), /Daily API request limit/);
  assert.equal(calls.length, 1, 'the second tab does not ask again');
  assert.equal(b.retryInMs(), 3_600_000);
  assert.match(describeError(b.lastError), /daily allowance/);
  t += 3_600_000;
  await assert.rejects(b.current());
  assert.equal(calls.length, 2, 'asked again once the hour has passed');
});

test('the day\'s limit leaves Open-Meteo alone for an hour and tells browsers so', async () => {
  let t = 9_000_000;
  const calls = [];
  const fetchJson = async (url) => { calls.push(url); throw new HttpError(429, 'api.open-meteo.com answered HTTP 429: {"reason":"Daily API request limit exceeded. Please try again tomorrow.","error":true}'); };
  const route = createOverlaysRoute({ url: 'https://meteo.test', fetchJson, now: () => t });
  const { base, close } = await serve({ overlays: route, browserFallback: false });
  try {
    assert.deepEqual((await (await fetch(`${base}/api/config`)).json()).overlays, { weather: true, browser: null }, 'BROWSER_FALLBACK=off keeps browsers out of it');
    const res = await fetch(`${base}/api/overlays/weather`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "Weather grid unavailable: Open-Meteo's daily allowance for this address is used up (it says: try again tomorrow)");
    assert.equal(body.retryInMs, 3_600_000);
    assert.equal(calls.length, 1);
    t += 59 * 60_000;
    const later = await (await fetch(`${base}/api/overlays/weather`)).json();
    assert.equal(calls.length, 1, 'one refused request an hour, not one a minute');
    assert.equal(later.retryInMs, 60_000);
    t += 2 * 60_000;
    await fetch(`${base}/api/overlays/weather`);
    assert.equal(calls.length, 2, 'asked again after the hour');
  } finally {
    close();
  }
});

test('the browser fetches the grid itself only when the server has nothing fit to draw for a while', () => {
  assert.equal(serverOut(null), true, 'the server is unreachable');
  assert.equal(serverOut({ done: 0, error: 'daily allowance used up', retryInMs: 3_600_000 }), true, 'no grid at all');
  assert.equal(serverOut({ done: 0, error: 'timed out', retryInMs: 60_000 }), true, 'no grid at all, whatever the wait');
  assert.equal(serverOut({ done: 612, partial: false, stale: false, error: null, retryInMs: 0 }), false, 'a fresh grid');
  assert.equal(serverOut({ done: 400, partial: true, stale: false, error: null, retryInMs: 0 }), false, 'a wave is on its way');
  assert.equal(serverOut({ done: 400, partial: true, stale: false, error: 'minute limit hit', retryInMs: 61_000 }), false, 'the server retries in a minute');
  assert.equal(serverOut({ done: 400, partial: true, stale: false, error: 'daily allowance used up', retryInMs: 3_600_000 }), true, 'the poles will not come for an hour');
  assert.equal(serverOut({ done: 612, partial: false, stale: true, error: 'daily allowance used up', retryInMs: 3_600_000 }), true, 'an old grid that will not be refreshed for an hour');
  assert.equal(serverOut({ done: 612, partial: false, stale: true, error: null, retryInMs: 0 }), false, 'an old grid being refreshed right now');
});

test('an empty OPEN_METEO_URL turns the weather overlay off', async () => {
  const route = createOverlaysRoute({ url: '' });
  assert.equal(route.enabled, false);
  const { base, close } = await serve({ overlays: route });
  try {
    assert.deepEqual((await (await fetch(`${base}/api/config`)).json()).overlays, { weather: false, browser: null });
    assert.equal((await fetch(`${base}/api/overlays/weather`)).status, 404);
  } finally {
    close();
  }
});

test('colour ramps blend between stops and clamp at the ends', () => {
  const r = RAMPS.temperature;
  assert.deepEqual(colorAt(r, -100), r.stops[0][1]);
  assert.deepEqual(colorAt(r, 100), r.stops.at(-1)[1]);
  assert.deepEqual(colorAt(r, null), [0, 0, 0, 0]);
  const mid = colorAt(r, 5); // halfway between the 0 and 10 stops
  assert.deepEqual(mid, r.stops[2][1].map((a, k) => Math.round((a + r.stops[3][1][k]) / 2)));
  assert.equal(colorAt(RAMPS.wind, 0)[3], 0, 'calm air is transparent');
  assert.match(rampCss(r), /^linear-gradient\(90deg, rgba\(120,100,220,[\d.]+\) 0\.0%/);
});

test('sampling blends the four grid points around a place and wraps at the antimeridian', () => {
  const grid = gridSpec(10);
  const values = gridPoints(grid).map(([lat, lon]) => lon); // the value is the longitude
  assert.equal(sample(grid, values, 0, -180), -180);
  assert.equal(sample(grid, values, 0, -175), -175);
  assert.equal(sample(grid, values, 45, 123.4).toFixed(1), '123.4');
  assert.equal(sample(grid, values, 0, 175), -5, '175°E sits between the 170 and -180 columns');
  assert.equal(sample(grid, values, 89, 0), 0, 'beyond the last row the edge row holds');
  values[0] = null;
  assert.equal(sample(grid, values, -80, -180), null, 'nothing around: nothing');
  assert.equal(sample(grid, values, -80, -175), -170, 'a missing neighbour drops out of the blend');
});

test('the painted image is Mercator from 85°N down, through the ramp', () => {
  assert.ok(Math.abs(latOfRow(0, 512) - 85.02) < 0.01);
  assert.ok(Math.abs(latOfRow(255.5, 512)) < 1e-9);
  const grid = gridSpec(10);
  const values = gridPoints(grid).map(([lat]) => lat);
  const px = paintField(grid, values, RAMPS.temperature, 8, 4);
  assert.equal(px.length, 8 * 4 * 4);
  assert.deepEqual([...px.slice(0, 4)], colorAt(RAMPS.temperature, sample(grid, values, latOfRow(0, 4), -180 + 22.5)));
  assert.ok(px[3] > 0 && px[(3 * 8) * 4 + 3] > 0, 'both polar rows are painted');
});

test('the Sun is where the almanac puts it, and the night side is the other half', () => {
  const equinox = subsolarPoint(new Date('2026-03-20T12:00:00Z'));
  assert.ok(Math.abs(equinox.lat) < 0.3, `equinox latitude ${equinox.lat}`);
  assert.ok(Math.abs(equinox.lon - 1.9) < 0.5, `noon at Greenwich, less the equation of time: ${equinox.lon}`);
  const solstice = subsolarPoint(new Date('2026-06-21T18:00:00Z'));
  assert.ok(Math.abs(solstice.lat - 23.44) < 0.1);
  assert.ok(Math.abs(solstice.lon + 90) < 1);
  const night = nightPolygon(new Date('2026-06-21T18:00:00Z'));
  assert.equal(night.geometry.type, 'Polygon');
  const ring = night.geometry.coordinates[0];
  assert.ok(ring.length > 100);
  assert.deepEqual(ring[0], ring.at(-1), 'closed');
  assert.ok(ring.some(([, lat]) => lat <= -89), 'reaches the dark (southern) pole in June');
  assert.ok(ring.every(([lon, lat]) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90));
});

test('a readout blends the fields at a place, takes the wind direction from the nearest point, and is null where the grid is empty', () => {
  const g = gridSpec(10);
  const n = g.rows * g.cols;
  const fields = { temperature: Array.from({ length: n }, (_, i) => g.lat0 + Math.floor(i / g.cols) * g.step), wind: new Array(n).fill(20), windDir: new Array(n).fill(null), rain: new Array(n).fill(0.5), clouds: new Array(n).fill(null) };
  fields.windDir[nearestIndex(g, 42, -105)] = 315;
  assert.equal(nearestIndex(g, 42, -105), 12 * g.cols + 8, '40°N, 100°W');
  assert.equal(nearestIndex(g, -85, 179.9), 0 * g.cols + 0, 'clamped south, wrapped east');
  const r = probe({ grid: g, fields }, 42, -105);
  assert.ok(Math.abs(r.temperature - 42) < 1e-9, 'latitude blends to the latitude');
  assert.equal(r.wind, 20);
  assert.equal(r.windDir, 315);
  assert.equal(r.rain, 0.5);
  assert.equal(r.clouds, null);
  for (const f of Object.keys(fields)) fields[f].fill(null);
  assert.equal(probe({ grid: g, fields }, 42, -105), null, 'nothing yet');
  assert.equal(compass(0), 'N');
  assert.equal(compass(315), 'NW');
  assert.equal(compass(359), 'N');
  assert.equal(compass(-90), 'W');
  assert.equal(compass(null), '');
  assert.equal(formatValue('temperature', 20, 'us'), '68');
  assert.equal(formatValue('temperature', 20.4, 'metric'), '20');
  assert.equal(formatValue('rain', 2.54, 'us'), '0.10');
  assert.equal(formatValue('rain', 2.54, 'metric'), '2.5');
  assert.equal(formatValue('wind', 16.09344, 'us'), '10');
  assert.equal(formatValue('clouds', null, 'us'), '');
});

test('units follow the browser: Fahrenheit, mph and inches for en-US', () => {
  assert.equal(localUnits('en-US'), 'us');
  assert.equal(localUnits('en-GB'), 'metric');
  assert.equal(convert('temperature', 20, 'us'), 68);
  assert.equal(convert('temperature', 20, 'metric'), 20);
  assert.equal(Math.round(convert('wind', 16.09344, 'us')), 10);
  assert.equal(convert('rain', 25.4, 'us'), 1);
  assert.equal(unitLabel('temperature', 'us'), '°F');
  assert.equal(unitLabel('wind', 'metric'), 'km/h');
  assert.equal(firesDay(Date.UTC(2026, 9, 14, 3)), '2026-10-13');
});

