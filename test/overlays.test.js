import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createOverlaysRoute, gridPoints, gridSpec, parseBatch } from '../server/overlays.js';
import { RAMPS, colorAt, convert, latOfRow, localUnits, nightPolygon, paintField, rampCss, sample, subsolarPoint, unitLabel } from '../public/js/overlays/field.js';
import { firesDay } from '../public/js/ui/overlays.js';

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
  assert.equal(gridSpec(1).step, 2.5); // never finer than 2.5°
});

test('parseBatch takes one point or many and refuses a short or refused answer', () => {
  assert.deepEqual(parseBatch({ current: { temperature_2m: 3, wind_speed_10m: 1, wind_direction_10m: 2, precipitation: 0, cloud_cover: 'n/a' } }, 1),
    [{ temperature: 3, wind: 1, windDir: 2, rain: 0, clouds: null }]);
  assert.equal(parseBatch([{ current: {} }, { current: {} }], 2).length, 2);
  assert.throws(() => parseBatch([{ current: {} }], 2), /1 of 2/);
  assert.throws(() => parseBatch({ error: true, reason: 'Too many' }, 1), /Too many/);
});

test('the route fetches the grid in batches on the first request, serves it from memory, refreshes when stale', async () => {
  const calls = [];
  let t = 1_000_000;
  const route = createOverlaysRoute({ url: 'https://meteo.test/v1/forecast', fetchJson: fakeJson(calls), now: () => t, refreshMin: '120' });
  assert.ok(route.enabled);
  const { base, close } = await serve({ overlays: route });
  try {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(config.overlays, { weather: true });
    const res = await fetch(`${base}/api/overlays/weather`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(calls.length, 7); // 612 points, 100 a request
    assert.ok(decodeURIComponent(calls[0]).startsWith('https://meteo.test/v1/forecast?latitude=-80,-80'));
    assert.ok(decodeURIComponent(calls[0]).includes('current=temperature_2m,wind_speed_10m'));
    assert.equal(d.fields.temperature.length, 612);
    assert.equal(d.fields.temperature[0], -80);
    assert.equal(d.fields.temperature.at(-1), 80);
    assert.equal(d.units.temperature, '°C');
    assert.equal(d.refreshMs, 120 * 60_000);
    assert.equal(d.stale, false);
    assert.equal(d.error, null);
    await fetch(`${base}/api/overlays/weather`);
    assert.equal(calls.length, 7, 'served from memory');
    t += 121 * 60_000;
    const again = await (await fetch(`${base}/api/overlays/weather`)).json();
    assert.equal(again.at, 1_000_000, 'the old grid is served while the refresh runs');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 14);
    assert.equal((await (await fetch(`${base}/api/overlays/weather`)).json()).at, t);
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
    assert.equal(calls.length, 7, 'every batch goes out together');
    assert.equal((await fetch(`${base}/api/overlays/weather`)).status, 502);
    assert.equal(calls.length, 7, 'not retried within a minute');
    fail = false;
    t += 61_000;
    assert.equal((await fetch(`${base}/api/overlays/weather`)).status, 200);
    fail = true;
    t += 3 * 3600_000;
    const stale = await (await fetch(`${base}/api/overlays/weather`)).json();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stale.stale, true);
    const after = await (await fetch(`${base}/api/overlays/weather`)).json();
    assert.match(after.error, /timed out/);
    assert.equal(after.fields.temperature.length, 612, 'the last grid is kept');
  } finally {
    close();
  }
});

test('an empty OPEN_METEO_URL turns the weather overlay off', async () => {
  const route = createOverlaysRoute({ url: '' });
  assert.equal(route.enabled, false);
  const { base, close } = await serve({ overlays: route });
  try {
    assert.deepEqual((await (await fetch(`${base}/api/config`)).json()).overlays, { weather: false });
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

