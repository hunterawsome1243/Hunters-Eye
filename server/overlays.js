// Weather overlays: a coarse world grid of current conditions for the globe's
// heat maps (temperature, wind, rain, cloud), from Open-Meteo.
//
// Open-Meteo's forecast API is keyless and free for non-commercial use, and it
// counts every location in a request as one call against its limits: 600 a
// minute, 5,000 an hour, 10,000 a day, per address. One grid refresh asks for
// every point of a GRID_DEG grid between 80°S and 80°N (10° -> 612 points, 100
// per request), so the default two-hour refresh spends ~7,300 of the day's calls,
// and only while someone is looking: the grid is fetched on the first request
// and refreshed on a request that finds it older than REFRESH_MIN. A grid goes
// out in waves of WAVE_POINTS a minute, the tropics and mid-latitudes first, so
// one refresh never crowds the minute limit (the address may be shared with other
// users of the host): the first answer is partial, and the poles follow a minute
// later. Each process start fetches afresh (a host that sleeps an idle free
// service costs one grid per wake), and an HTTP 429 is honoured for as long as
// its Retry-After says. The browser (public/js/ui/overlays.js) interpolates
// between the points and paints them.
//
// OPEN_METEO_URL overrides the endpoint (empty turns the overlay off, and
// /api/config says so); OVERLAY_GRID_DEG and OVERLAY_REFRESH_MIN tune the cost.
import { getJson } from './lib/http.js';

export const DEFAULT_URL = 'https://api.open-meteo.com/v1/forecast';
export const FIELDS = ['temperature', 'wind', 'windDir', 'rain', 'clouds'];
const CURRENT = 'temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover';
const BATCH = 100; // points per request
const WAVE_POINTS = 400; // points per minute, under Open-Meteo's 600 with room for whoever shares the address
const WAVE_GAP_MS = 61_000;
const FAIL_TTL_MS = 60_000;
const TIMEOUT_MS = 15_000;
const LAT_MAX = 80; // the ice caps round the grid off and would cost a third more points

// Grid spacings whose columns close exactly round the planet (360 divides by them).
// Finer than 10° overspends the free allowance at the default refresh: the cost is
// points × (1440 ÷ OVERLAY_REFRESH_MIN) location-requests a day, against 10,000.
export const STEPS = [5, 6, 7.5, 9, 10, 12, 15, 18, 20, 30];

// The grid's points, south to north then west to east, row-major. An unlisted
// spacing snaps to the nearest listed one, so the last column always meets the first.
export function gridSpec(stepDeg = 10) {
  const asked = Number(stepDeg) || 10;
  const step = STEPS.reduce((best, s) => (Math.abs(s - asked) < Math.abs(best - asked) ? s : best));
  const lat0 = -Math.floor(LAT_MAX / step) * step;
  const rows = Math.floor((LAT_MAX - lat0) / step) + 1;
  const cols = Math.round(360 / step);
  return { lat0, lon0: -180, step, rows, cols };
}

export function gridPoints({ lat0, lon0, step, rows, cols }) {
  const pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push([lat0 + r * step, lon0 + c * step]);
  return pts;
}

// Open-Meteo answers one location as an object and several as an array.
export function parseBatch(data, expected) {
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  if (data?.error) throw new Error(data.reason || 'Open-Meteo refused the request');
  if (list.length !== expected) throw new Error(`Open-Meteo answered ${list.length} of ${expected} points`);
  return list.map((p) => {
    const c = p.current ?? {};
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { temperature: n(c.temperature_2m), wind: n(c.wind_speed_10m), windDir: n(c.wind_direction_10m), rain: n(c.precipitation), clouds: n(c.cloud_cover) };
  });
}

// The order the points are asked for: the equator first, the poles last, so the
// first wave of a grid covers the latitudes where almost everyone looks.
export function fetchOrder(points) {
  return points.map((p, i) => i).sort((a, b) => Math.abs(points[a][0]) - Math.abs(points[b][0]) || a - b);
}

export function createOverlaysRoute({
  url = process.env.OPEN_METEO_URL ?? DEFAULT_URL,
  gridDeg = process.env.OVERLAY_GRID_DEG,
  refreshMin = process.env.OVERLAY_REFRESH_MIN,
  fetchJson = getJson,
  now = Date.now,
} = {}) {
  const enabled = !!url;
  const grid = gridSpec(gridDeg);
  const refreshMs = Math.max(Number(refreshMin) || 120, 15) * 60_000;
  const points = gridPoints(grid);
  const order = fetchOrder(points);
  const units = { temperature: '°C', wind: 'km/h', rain: 'mm', clouds: '%' };
  let data = null; // the grid being served: { at, updated, grid, fields, done, total, partial, units, refreshMs }
  let next = null; // its replacement, built in waves while the old grid is still served
  let inflight = null; // the wave on its way
  let waveAt = 0; // when the last wave went out; the next waits WAVE_GAP_MS
  let retryAt = 0; // after a failure, no attempt before this
  let lastError = null;

  function emptyGrid(t) {
    return { at: t, updated: t, grid, fields: Object.fromEntries(FIELDS.map((f) => [f, new Array(points.length).fill(null)])), done: 0, total: points.length, partial: true, units, refreshMs };
  }

  // One wave: the next WAVE_POINTS points of the grid, their batches sent together
  // so one slow answer costs one timeout, written into the grid as they come back.
  async function fetchWave(g) {
    const idx = order.slice(g.done, g.done + WAVE_POINTS);
    const batches = [];
    for (let i = 0; i < idx.length; i += BATCH) batches.push(idx.slice(i, i + BATCH));
    const parsed = await Promise.all(batches.map((batch) => {
      const q = new URLSearchParams({ latitude: batch.map((i) => points[i][0]).join(','), longitude: batch.map((i) => points[i][1]).join(','), current: CURRENT, timeformat: 'unixtime' });
      return fetchJson(`${url}?${q}`, { timeoutMs: TIMEOUT_MS }).then((data) => parseBatch(data, batch.length));
    }));
    batches.forEach((batch, k) => batch.forEach((i, j) => { for (const f of FIELDS) g.fields[f][i] = parsed[k][j][f]; }));
    g.done += idx.length;
    g.partial = g.done < points.length;
    g.updated = now();
    return g;
  }

  // The grid, refreshed when stale. The first request waits for the first wave and
  // gets a partial grid; later requests get what has arrived while the rest comes
  // in, a wave a minute. A complete grid is served until its replacement is
  // complete too. A wave that fails keeps what there is (marked stale or partial
  // in the answer) and is not tried again for a minute, or for as long as a
  // Retry-After header asks: a rate-limited Open-Meteo is left alone, not hammered.
  async function current() {
    const t = now();
    const complete = data && !data.partial;
    if (complete && t - data.at < refreshMs) return data;
    if (!inflight && t >= retryAt && t - waveAt >= WAVE_GAP_MS) {
      if (data?.partial && t - data.at >= refreshMs) data = emptyGrid(t); // too old to finish: start over
      let g;
      if (data && data.partial) g = data;
      else if (complete) g = next ?? (next = emptyGrid(t));
      else g = data = emptyGrid(t);
      waveAt = t;
      inflight = fetchWave(g).then(() => {
        lastError = null;
        if (g === next && !g.partial) { data = g; next = null; }
        return g;
      }).catch((err) => {
        retryAt = now() + Math.max(FAIL_TTL_MS, err.retryAfterMs || 0);
        lastError = err;
        throw err;
      }).finally(() => { inflight = null; });
    }
    if (data && data.done > 0) {
      inflight?.catch(() => {}); // what there is goes out now; the failure is logged below
      return data;
    }
    if (!inflight) throw lastError;
    return inflight.then(() => data);
  }

  async function handler(req, res) {
    if (!enabled) return res.status(404).json({ error: 'Weather overlays are off' });
    try {
      const d = await current();
      res.set('Cache-Control', d.partial ? 'no-store' : 'public, max-age=300');
      res.json({ ...d, stale: now() - d.at >= refreshMs, error: lastError?.message ?? null });
    } catch (err) {
      console.warn('Weather overlay:', err.message);
      res.status(502).json({ error: `Weather grid unavailable: ${err.message}` });
    }
  }

  return { enabled, grid, refreshMs, handler, current };
}
