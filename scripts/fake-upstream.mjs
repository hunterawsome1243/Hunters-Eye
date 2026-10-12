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

export const routes = {
  '/usgs': usgs,
  '/opensky/states/all': opensky,
};

export function startFakeUpstream(port = 0) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const handler = routes[path];
    if (!handler) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = handler(req);
    const isText = typeof body === 'string';
    res.writeHead(200, { 'Content-Type': isText ? 'text/plain' : 'application/json' });
    res.end(isText ? body : JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
