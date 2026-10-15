// A stand-in for the four upstream APIs, used only by `npm run smoke -- --fake`
// to exercise the whole app when the real feeds are unreachable (offline, CI,
// or a network that blocks them). Payloads mirror each API's documented shape.
import http from 'node:http';

const now = () => Date.now();

function usgs() {
  const t = now();
  const f = (id, mag, lon, lat, depth, agoMin, place) => ({
    type: 'Feature', id,
    properties: { mag, place, time: t - agoMin * 60e3, updated: t, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`, status: 'reviewed', tsunami: 0, magType: 'mb', type: 'earthquake', felt: null, alert: null },
    geometry: { type: 'Point', coordinates: [lon, lat, depth] },
  });
  return {
    type: 'FeatureCollection',
    metadata: { generated: t, count: 5 },
    features: [
      f('fake001', 6.1, 142.3, 38.1, 35, 12, '95 km E of Namie, Japan'),
      f('fake002', 4.7, -72.5, -33.2, 22, 150, '40 km W of Valparaíso, Chile'),
      f('fake003', 3.2, -117.6, 35.7, 8, 400, '12 km SW of Searles Valley, CA'),
      f('fake004', 2.8, 28.1, 39.2, 10, 900, '8 km N of Simav, Turkey'),
      f('fake005', 1.1, -150.1, 61.3, 40, 60, '20 km N of Anchorage, Alaska'),
    ],
  };
}

// Deterministic pseudo-random numbers so every run draws the same traffic.
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function opensky(req) {
  const q = new URL(req.url, 'http://x').searchParams;
  const box = q.has('lamin') ? ['lamin', 'lomin', 'lamax', 'lomax'].map((k) => Number(q.get(k))) : [-60, -180, 70, 180];
  const r = rng(42);
  const t = Math.floor(now() / 1000);
  const states = [];
  for (let i = 0; i < 4000; i++) {
    const lat = -50 + r() * 115;
    const lon = -180 + r() * 360;
    if (lat < box[0] || lat > box[2] || lon < box[1] || lon > box[3]) continue;
    const onGround = r() < 0.06;
    const squawk = i === 7 ? '7700' : i === 99 ? '7600' : String(1000 + Math.floor(r() * 6000));
    states.push([
      (0xa00000 + i).toString(16), `TST${String(i).padStart(4, '0')} `, ['United States', 'Germany', 'Japan', 'Brazil'][i % 4],
      t - 4, t - 1, lon, lat, onGround ? null : 1000 + r() * 11000, onGround, onGround ? 5 : 120 + r() * 140,
      r() * 360, onGround ? null : (r() - 0.5) * 20, null, onGround ? null : 1000 + r() * 11000, squawk, false, 0, Math.floor(r() * 8),
    ]);
  }
  return { time: t, states };
}

// Builds a valid TLE pair with today's epoch, so SGP4 propagates it accurately.
function tle(name, num, intl, inc, raan, ecc, argp, ma, mm) {
  const d = new Date();
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const day = (d - start) / 86_400_000 + 1;
  const epoch = `${String(d.getUTCFullYear() % 100).padStart(2, '0')}${day.toFixed(8).padStart(12, '0')}`;
  const f = (n, w, p) => n.toFixed(p).padStart(w);
  const sum = (l) => [...l].reduce((a, c) => a + (c === '-' ? 1 : /\d/.test(c) ? Number(c) : 0), 0) % 10;
  const l1 = `1 ${num}U ${intl.padEnd(8)} ${epoch}  .00010000  00000-0  18000-3 0  999`;
  const l2 = `2 ${num} ${f(inc, 8, 4)} ${f(raan, 8, 4)} ${String(ecc).padStart(7, '0')} ${f(argp, 8, 4)} ${f(ma, 8, 4)} ${f(mm, 11, 8)}12345`;
  return `${name}\n${l1}${sum(l1)}\n${l2}${sum(l2)}\n`;
}

function celestrak(req) {
  const group = new URL(req.url, 'http://x').searchParams.get('GROUP');
  if (group === 'STATIONS') {
    return tle('ISS (ZARYA)', '25544', '98067A', 51.64, 247.46, '0006703', 130.5, 325.0, 15.4981)
      + tle('CSS (TIANHE)', '48274', '21035A', 41.47, 120.0, '0005000', 300.0, 60.0, 15.6);
  }
  return tle('HST', '20580', '90037B', 28.47, 100.0, '0002500', 90.0, 270.0, 15.14)
    + tle('NOAA 19', '33591', '09005A', 99.19, 40.0, '0013000', 200.0, 160.0, 14.13)
    + tle('ENVISAT', '27386', '02009A', 98.2, 10.0, '0001000', 80.0, 280.0, 14.38)
    + tle('SL-16 R/B', '22285', '92093B', 71.0, 300.0, '0008000', 10.0, 350.0, 14.15);
}

function nws() {
  const t = now();
  const iso = (ms) => new Date(ms).toISOString();
  const zone = (type, id) => `https://api.weather.gov/zones/${type}/${id}`;
  const alert = (id, event, severity, areaDesc, geometry, zones, agoMin) => ({
    id: `https://api.weather.gov/alerts/${id}`,
    type: 'Feature',
    geometry,
    properties: {
      id, event, severity, areaDesc, certainty: 'Likely', urgency: 'Expected', senderName: 'NWS Test Office',
      headline: `${event} issued for ${areaDesc}`, sent: iso(t - agoMin * 60e3), effective: iso(t - agoMin * 60e3),
      expires: iso(t + 3 * 3600e3), description: `* WHAT...${event}.\n\n* WHERE...${areaDesc}.`, instruction: 'Stay alert.',
      affectedZones: zones,
    },
  });
  return {
    type: 'FeatureCollection',
    updated: iso(t),
    features: [
      alert('urn:fake:1', 'Tornado Warning', 'Extreme', 'Oklahoma County, OK', {
        type: 'Polygon', coordinates: [[[-97.7, 35.3], [-97.2, 35.3], [-97.2, 35.7], [-97.7, 35.7], [-97.7, 35.3]]],
      }, [zone('county', 'OKC109')], 5),
      alert('urn:fake:2', 'Excessive Heat Warning', 'Severe', 'Maricopa; Pinal', null, [zone('forecast', 'AZZ537'), zone('forecast', 'AZZ553')], 90),
      alert('urn:fake:3', 'Winter Storm Watch', 'Moderate', 'Northern Cascades', null, [zone('forecast', 'WAZ567')], 240),
      alert('urn:fake:4', 'Small Craft Advisory', 'Minor', 'Coastal waters', null, [zone('marine', 'PZZ999')], 30),
    ],
  };
}

const ZONE_BOXES = { AZZ537: [-113, 33, -111.6, 34], AZZ553: [-111.6, 32.5, -110.5, 33.4], WAZ567: [-121.8, 48, -120.5, 49], OKC109: [-97.7, 35.3, -97.1, 35.7] };

function nwsZone(req) {
  const id = new URL(req.url, 'http://x').pathname.split('/').pop();
  const b = ZONE_BOXES[id];
  if (!b) return { status: 404, body: 'zone not found' };
  return { type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] }, properties: { id } };
}

// ipwho.is stand-in: every visitor is placed in Denver.
function whereami() {
  return { success: true, ip: '203.0.113.7', city: 'Denver', region: 'Colorado', country: 'United States', latitude: 39.7392, longitude: -104.9903 };
}

// Open-Meteo stand-in: a plausible planet (warm equator, cold poles, a wet band,
// a storm in the Atlantic) for the weather overlays, at every point asked for.
function openMeteo(req) {
  const q = new URL(req.url, 'http://x').searchParams;
  const lats = (q.get('latitude') ?? '').split(',').map(Number);
  const lons = (q.get('longitude') ?? '').split(',').map(Number);
  const t = Math.floor(now() / 1000);
  const units = { time: 'unixtime', temperature_2m: '°C', wind_speed_10m: 'km/h', wind_direction_10m: '°', precipitation: 'mm', cloud_cover: '%' };
  const list = lats.map((lat, i) => {
    const lon = lons[i];
    const storm = Math.exp(-(((lat - 30) / 9) ** 2 + ((lon + 50) / 12) ** 2));
    const temperature = Math.round((29 - 0.62 * Math.abs(lat) + 5 * Math.sin((lon + 20) / 40) - 8 * storm) * 10) / 10;
    const wind = Math.round((12 + 10 * Math.abs(Math.sin(lat / 25)) + 70 * storm) * 10) / 10;
    const precipitation = Math.round((Math.max(0, 1.5 * Math.exp(-(((lat - 5) / 10) ** 2)) * (1 + Math.sin(lon / 30))) + 9 * storm) * 100) / 100;
    const clouds = Math.round(Math.min(100, 25 + 40 * Math.abs(Math.sin(lat / 18 + lon / 60)) + 70 * storm));
    return {
      latitude: lat, longitude: lon, generationtime_ms: 0.1, utc_offset_seconds: 0, timezone: 'GMT', timezone_abbreviation: 'GMT', elevation: 0,
      current_units: units,
      current: { time: t, temperature_2m: temperature, wind_speed_10m: wind, wind_direction_10m: Math.round((lat + lon + 360) % 360), precipitation, cloud_cover: clouds },
    };
  });
  return list.length === 1 ? list[0] : list;
}

// Open-Meteo refusing an address that has used up the day's allowance (what Render's
// shared address got on 2026-10-15): the server-blocked smoke points the server here.
function openMeteoLimited() {
  return { status: 429, body: JSON.stringify({ error: true, reason: 'Daily API request limit exceeded. Please try again tomorrow.' }) };
}

export const routes = {
  '/open-meteo-limited': openMeteoLimited,
  '/open-meteo': openMeteo,
  '/whereami': whereami,
  '/nws': nws,
  '/zones': nwsZone,
  '/celestrak': celestrak,
  '/usgs': usgs,
  '/opensky/states/all': opensky,
};

export function startFakeUpstream(port = 0) {
  const server = http.createServer((req, res) => {
    // Like the real CelesTrak, answer cross-origin requests from the browser
    // fallback, except under /nocors/, which stands in for a site that doesn't.
    const cors = !req.url.startsWith('/nocors/');
    if (!cors) req.url = req.url.slice('/nocors'.length);
    const headers = (type) => ({ 'Content-Type': type, ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) });
    const path = new URL(req.url, 'http://x').pathname;
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}/`));
    const handler = routes[key];
    if (!handler) {
      res.writeHead(404).end('not found');
      return;
    }
    let body = handler(req);
    if (body && body.status) {
      res.writeHead(body.status, headers('text/plain')).end(body.body);
      return;
    }
    const isText = typeof body === 'string';
    res.writeHead(200, headers(isText ? 'text/plain' : 'application/json'));
    res.end(isText ? body : JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
