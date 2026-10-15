// Weather overlays: this server's copy of the Open-Meteo current-conditions grid
// behind the globe's heat maps (temperature, wind, rain, cloud). The grid, its
// waves and its limits live in shared/openmeteo.js, because a browser fetches the
// grid the same way, itself, when this server's address has used up Open-Meteo's
// allowance: hosts such as Render send every customer's traffic from a few shared
// addresses, so the day's 10,000 calls can be gone before this server has spent
// its own 7,300. The answer carries how long the server will wait before asking
// again, and a browser that sees a long wait goes to Open-Meteo on its own
// address instead (public/js/ui/overlays.js).
//
// OPEN_METEO_URL overrides the endpoint (empty turns the overlay off, and
// /api/config says so); OPEN_METEO_BROWSER_URL is where browsers go instead, the
// public API by default; OVERLAY_GRID_DEG and OVERLAY_REFRESH_MIN tune the cost.
import { getJson } from './lib/http.js';
import { DEFAULT_URL, FIELDS, STEPS, createGridLoader, describeError, fetchOrder, gridPoints, gridSpec, parseBatch } from '../shared/openmeteo.js';

export { DEFAULT_URL, FIELDS, STEPS, fetchOrder, gridPoints, gridSpec, parseBatch };

export function createOverlaysRoute({
  url = process.env.OPEN_METEO_URL ?? DEFAULT_URL,
  browserUrl = process.env.OPEN_METEO_BROWSER_URL || DEFAULT_URL,
  gridDeg = process.env.OVERLAY_GRID_DEG,
  refreshMin = process.env.OVERLAY_REFRESH_MIN,
  fetchJson = getJson,
  now = Date.now,
} = {}) {
  const loader = createGridLoader({ url, gridDeg, refreshMin, fetchJson, now, onError: (err) => console.warn('Weather overlay:', err.message) });
  const { enabled, grid, refreshMs } = loader;

  // The grid (what has arrived, with `error` when its last wave failed), or 502
  // with the reason; either way `retryInMs` says how long this server leaves
  // Open-Meteo alone, so a browser can tell a minute's pause from an hour's.
  async function handler(req, res) {
    if (!enabled) return res.status(404).json({ error: 'Weather overlays are off' });
    try {
      const d = await loader.current();
      const stale = now() - d.at >= refreshMs;
      // Only a whole, fresh, untroubled grid may be cached, and only until it is
      // stale: a browser deciding whether to fetch for itself needs the server's
      // current state, not a five-minute-old copy.
      const ttl = d.partial || stale || loader.lastError ? 0 : Math.min(300, Math.floor((refreshMs - (now() - d.at)) / 1000));
      res.set('Cache-Control', ttl > 0 ? `public, max-age=${ttl}` : 'no-store');
      res.json({ ...d, stale, error: loader.lastError ? describeError(loader.lastError) : null, retryInMs: loader.retryInMs() });
    } catch (err) {
      res.status(502).json({ error: `Weather grid unavailable: ${describeError(err)}`, retryInMs: loader.retryInMs() });
    }
  }

  // What /api/config tells browsers about fetching the grid themselves.
  const browser = enabled && browserUrl ? { url: browserUrl, gridDeg: grid.step, refreshMin: refreshMs / 60_000 } : null;

  return { enabled, grid, refreshMs, handler, current: loader.current, browser };
}
