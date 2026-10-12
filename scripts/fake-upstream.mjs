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

export const routes = {
  '/usgs': usgs,
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
