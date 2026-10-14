// Weather overlays: a coarse world grid of current conditions for the globe's
// heat maps (temperature, wind, rain, cloud), from Open-Meteo.
//
// Open-Meteo's forecast API is keyless and free for non-commercial use (about
// 10,000 location-requests a day). One grid refresh asks for every point of a
// GRID_DEG grid between 80°S and 80°N (10° -> 612 points, in batches of 100
// per request), so the default two-hour refresh spends ~7,300 of those a day,
// and only while someone is looking: the grid is fetched on the first request
// and refreshed on a request that finds it older than REFRESH_MIN. The browser
// (public/js/ui/overlays.js) interpolates between the points and paints them.
//
// OPEN_METEO_URL overrides the endpoint (empty turns the overlay off, and
// /api/config says so); OVERLAY_GRID_DEG and OVERLAY_REFRESH_MIN tune the cost.
import { getJson } from './lib/http.js';

export const DEFAULT_URL = 'https://api.open-meteo.com/v1/forecast';
export const FIELDS = ['temperature', 'wind', 'windDir', 'rain', 'clouds'];
const CURRENT = 'temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover';
const BATCH = 100;
const FAIL_TTL_MS = 60_000;
const TIMEOUT_MS = 15_000;
const LAT_MAX = 80; // the ice caps round the grid off and would cost a third more points

// The grid's points, south to north then west to east, row-major.
export function gridSpec(stepDeg = 10) {
  const step = Math.min(Math.max(Number(stepDeg) || 10, 2.5), 30);
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
  let data = null; // { at, grid, fields, next }
  let failedAt = 0;
  let lastError = null;
  let inflight = null;

  // The batches go out together (seven requests for the default grid, well inside
  // Open-Meteo's 600 a minute), so one slow answer costs one timeout, not seven in a
  // row, and the first grid is on screen in seconds rather than a minute.
  async function fetchGrid() {
    const batches = [];
    for (let i = 0; i < points.length; i += BATCH) batches.push(points.slice(i, i + BATCH));
    const parsed = await Promise.all(batches.map((batch) => {
      const q = new URLSearchParams({ latitude: batch.map((p) => p[0]).join(','), longitude: batch.map((p) => p[1]).join(','), current: CURRENT, timeformat: 'unixtime' });
      return fetchJson(`${url}?${q}`, { timeoutMs: TIMEOUT_MS }).then((data) => parseBatch(data, batch.length));
    }));
    const fields = Object.fromEntries(FIELDS.map((f) => [f, []]));
    for (const p of parsed.flat()) for (const f of FIELDS) fields[f].push(p[f]);
    return { at: now(), grid, fields, units: { temperature: '°C', wind: 'km/h', rain: 'mm', clouds: '%' }, refreshMs };
  }

  // The grid, refreshed when stale. A refresh that fails keeps the last grid (marked
  // stale in the answer) and is not tried again for a minute.
  async function current() {
    const t = now();
    const fresh = data && t - data.at < refreshMs;
    if (fresh) return data;
    if (!inflight && t - failedAt >= FAIL_TTL_MS) {
      inflight = fetchGrid().then((d) => { data = d; lastError = null; return d; }).catch((err) => {
        failedAt = now();
        lastError = err;
        throw err;
      }).finally(() => { inflight = null; });
    }
    if (data) {
      inflight?.catch(() => {}); // the old grid is served meanwhile; the failure is logged below
      return data;
    }
    if (!inflight) throw lastError;
    return inflight;
  }

  async function handler(req, res) {
    if (!enabled) return res.status(404).json({ error: 'Weather overlays are off' });
    try {
      const d = await current();
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ ...d, stale: now() - d.at >= refreshMs, error: lastError?.message ?? null });
    } catch (err) {
      console.warn('Weather overlay:', err.message);
      res.status(502).json({ error: `Weather grid unavailable: ${err.message}` });
    }
  }

  return { enabled, grid, refreshMs, handler, current };
}
