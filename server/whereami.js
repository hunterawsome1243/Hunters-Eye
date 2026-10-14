// "You are here": where the visitor is, from their IP address, so the globe can
// plot them and the detail card can say how far an alert is from them.
//
// The browser asks this server (GET /api/whereami); the server looks the address
// up at ipwho.is, a keyless service that answers over HTTPS with city accuracy
// (tens of km at best, sometimes the wrong city), and caches the answer for an
// hour per address. Nothing is looked up until the visitor presses the button
// (public/js/ui/here.js), and no address is kept beyond the cache.
//
// WHEREAMI_URL overrides the service ({ip} is replaced by the address; an empty
// value turns the route off). Behind Render's proxy the real address is in
// X-Forwarded-For, which Express reads once `trust proxy` is set (server/app.js).

export const DEFAULT_URL = 'https://ipwho.is/{ip}';
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX = 500;

// Loopback and private ranges (a local run, a container): the service can't place
// them, so ask it about the server's own public address instead.
export function isPrivate(ip) {
  if (!ip) return true;
  const v4 = ip.replace(/^::ffff:/, '');
  if (v4 === '127.0.0.1' || v4 === '::1' || v4 === 'localhost') return true;
  if (/^10\./.test(v4) || /^192\.168\./.test(v4) || /^172\.(1[6-9]|2\d|3[01])\./.test(v4) || /^169\.254\./.test(v4)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return false;
}

// What ipwho.is returns, trimmed to what the globe needs. Other services can be
// adapted here: anything with latitude/longitude (or lat/lon) and a city works.
export function parseLookup(data) {
  if (!data || typeof data !== 'object') throw new Error('Empty lookup');
  if (data.success === false) throw new Error(data.message || 'Lookup refused');
  const lat = Number(data.latitude ?? data.lat);
  const lon = Number(data.longitude ?? data.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Lookup had no coordinates');
  const place = [data.city, data.region, data.country].filter((p) => typeof p === 'string' && p).join(', ');
  return { lat, lon, place, source: 'ip' };
}

export function createWhereamiRoute({ url = process.env.WHEREAMI_URL ?? DEFAULT_URL, fetchImpl = fetch, now = Date.now } = {}) {
  const enabled = !!url;
  const cache = new Map(); // ip -> { at, value }

  async function lookup(ip) {
    const key = isPrivate(ip) ? '' : ip;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;
    const res = await fetchImpl(url.replace('{ip}', key), { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const value = parseLookup(await res.json());
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), value });
    return value;
  }

  async function handler(req, res) {
    if (!enabled) return res.status(404).json({ error: 'Location is off: WHEREAMI_URL is empty on the server.' });
    res.set('Cache-Control', 'private, max-age=3600');
    try {
      const value = await lookup(req.ip);
      res.json({ ...value, approximate: true });
    } catch (err) {
      console.warn('[whereami]', err?.message ?? err);
      res.status(502).json({ error: `Could not place your address: ${err?.message ?? err}` });
    }
  }
  return { enabled, handler, lookup };
}
