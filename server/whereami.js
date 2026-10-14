// "You are here": where the visitor is, from their IP address, so the globe can
// plot them, the proximity feed can order by distance, and the detail card can say
// how far an alert is from them.
//
// The browser asks this server (GET /api/whereami); the server asks a chain of
// keyless geolocation services in turn (ipwho.is, then ipapi.co, then freeipapi.com)
// until one answers with city accuracy (tens of km at best, sometimes the wrong
// city), and caches the answer for an hour per address. A service that refuses
// (ipwho.is answered HTTP 429 from Render's shared address on the first live day)
// is skipped for the next one, and a failure of the whole chain is remembered for a
// minute so reloads do not hammer them. No address is kept beyond the cache.
//
// WHEREAMI_URL overrides the chain: one or more templates separated by commas,
// {ip} replaced by the address (an empty value turns the route off). Behind
// Render's proxy the real address is in X-Forwarded-For, which Express reads once
// `trust proxy` is set (server/app.js).

export const DEFAULT_URL = 'https://ipwho.is/{ip},https://ipapi.co/{ip}/json/,https://freeipapi.com/api/json/{ip}';
const CACHE_TTL_MS = 60 * 60_000;
const FAIL_TTL_MS = 60_000;
const CACHE_MAX = 500;
const PER_SERVICE_MS = 5000;
const USER_AGENT = 'hunters-eye/0.1 (+https://github.com/hunterawsome1243/Hunters-Eye)';

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

// A template with the address filled in. An empty address (the server's own) drops
// its path segment, so "https://ipapi.co/{ip}/json/" becomes "https://ipapi.co/json/".
export function fillUrl(template, ip) {
  if (ip) return template.replace('{ip}', ip);
  return template.replace('/{ip}/', '/').replace(/\/\{ip\}$/, '/').replace('{ip}', '');
}

export const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

// What the services return, trimmed to what the globe needs. ipwho.is: latitude,
// longitude, city, region, country, success. ipapi.co: latitude, longitude, city,
// region, country_name, error + reason. freeipapi.com: latitude, longitude, cityName,
// regionName, countryName. ip-api.com style (lat, lon, regionName, status) also works.
export function parseLookup(data) {
  if (!data || typeof data !== 'object') throw new Error('Empty lookup');
  if (data.success === false || data.error === true || data.status === 'fail') throw new Error(data.message || data.reason || 'Lookup refused');
  const lat = Number(data.latitude ?? data.lat);
  const lon = Number(data.longitude ?? data.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Lookup had no coordinates');
  const city = data.city ?? data.cityName;
  const region = data.region ?? data.region_name ?? data.regionName;
  const country = data.country ?? data.country_name ?? data.countryName;
  const place = [city, region, country].filter((p) => typeof p === 'string' && p).join(', ');
  return { lat, lon, place, source: 'ip' };
}

export function createWhereamiRoute({ url = process.env.WHEREAMI_URL ?? DEFAULT_URL, fetchImpl = fetch, now = Date.now } = {}) {
  const urls = String(url ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  const enabled = urls.length > 0;
  const cache = new Map(); // ip -> { at, value } or { at, error }

  async function askOne(template, key) {
    const res = await fetchImpl(fillUrl(template, key), { signal: AbortSignal.timeout(PER_SERVICE_MS), headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseLookup(await res.json());
  }

  async function lookup(ip) {
    const key = isPrivate(ip) ? '' : ip;
    const hit = cache.get(key);
    if (hit && now() - hit.at < (hit.error ? FAIL_TTL_MS : CACHE_TTL_MS)) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    const failures = [];
    for (const template of urls) {
      try {
        const value = await askOne(template, key);
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, { at: now(), value });
        return value;
      } catch (err) {
        failures.push(`${hostOf(template)}: ${err?.message ?? err}`);
      }
    }
    const error = new Error(failures.join('; '));
    error.rateLimited = failures.every((f) => /HTTP 429/.test(f));
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), error });
    throw error;
  }

  async function handler(req, res) {
    if (!enabled) return res.status(404).json({ error: 'Location is off: WHEREAMI_URL is empty on the server.' });
    res.set('Cache-Control', 'private, max-age=3600');
    try {
      const value = await lookup(req.ip);
      res.json({ ...value, approximate: true });
    } catch (err) {
      console.warn('[whereami]', err?.message ?? err);
      const why = err?.rateLimited ? 'the address lookup services are rate-limited right now' : (err?.message ?? String(err));
      res.status(502).json({ error: `Could not place your address: ${why}`, rateLimited: !!err?.rateLimited });
    }
  }
  return { enabled, urls, handler, lookup };
}
