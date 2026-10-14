import express from 'express';
import { fileURLToPath } from 'node:url';
import { SourcePoller } from './lib/poller.js';
import { createBriefRoute } from './brief.js';
import { createDescribeRoute } from './describe.js';
import { createWhereamiRoute } from './whereami.js';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

// OpenFreeMap's dark style: free with no key or sign-up. CARTO's basemaps, used
// before, began requiring an API key in 2026.
const DEFAULT_BASEMAP = 'https://tiles.openfreemap.org/styles/dark';

// Satellite imagery under the vector map, from space down to about z12: EOX's
// Sentinel-2 cloudless mosaic (2016 global layer, CC BY 4.0), keyless. The browser
// falls back to NASA Blue Marble on its own if these tiles fail.
const DEFAULT_IMAGERY_TILES = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg';
const DEFAULT_IMAGERY_ATTRIBUTION = '<a href="https://cloudless.eox.at">EOxCloudless</a> by <a href="https://eox.at">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2016) | <a href="https://maps.eox.at">EOX::Maps</a>';

export function imageryConfig(env = process.env) {
  const tiles = env.IMAGERY_TILES ?? DEFAULT_IMAGERY_TILES;
  if (!tiles) return null; // IMAGERY_TILES= (empty) turns imagery off
  return {
    tiles,
    attribution: env.IMAGERY_ATTRIBUTION ?? (tiles === DEFAULT_IMAGERY_TILES ? DEFAULT_IMAGERY_ATTRIBUTION : ''),
    maxzoom: Math.min(Math.max(Number(env.IMAGERY_MAXZOOM) || 12, 1), 19),
  };
}

export function createApp(sources, pollerOptions, {
  browserFallback = process.env.BROWSER_FALLBACK !== 'off',
  basemapStyle = process.env.BASEMAP_STYLE || DEFAULT_BASEMAP,
  imagery = imageryConfig(),
  brief = createBriefRoute(),
  describe = createDescribeRoute(),
  whereami = createWhereamiRoute(),
  trustProxy = process.env.TRUST_PROXY ?? (process.env.RENDER ? '1' : ''),
} = {}) {
  const pollers = new Map(sources.map((s) => [s.id, new SourcePoller(s, pollerOptions)]));
  const app = express();
  app.disable('x-powered-by');
  // Behind a host's proxy (Render sets RENDER=true) the visitor's address is in
  // X-Forwarded-For; TRUST_PROXY=1 (or a hop count) turns that on elsewhere.
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  app.use(express.static(root('public')));
  app.use('/vendor/satellite.js', express.static(root('node_modules/satellite.js/dist')));
  app.use('/vendor/maplibre-gl', express.static(root('node_modules/maplibre-gl/dist')));
  app.use('/shared', express.static(root('shared')));

  // For a host's health checks. Unlike /api/status it doesn't count as a viewer,
  // so it never keeps the upstream feeds polling on its own.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Read once by the browser. `basemap` is the MapLibre style for the globe's
  // vector map, `imagery` the raster tiles drawn under it from space (null = none).
  // `fallback` lists the sources the browser may fetch itself, and from where,
  // while this server can't reach them (public/js/fallback.js). `brief` says
  // whether the "Brief me" button should exist (server/brief.js), `describe`
  // whether the detail card's "Describe" button should (server/describe.js),
  // `whereami` whether the "You are here" button should (server/whereami.js).
  app.get('/api/config', (req, res) => {
    const fallback = browserFallback ? sources.filter((s) => s.browserUrl).map((s) => [s.id, s.browserUrl]) : [];
    res.json({ basemap: basemapStyle, imagery, fallback: Object.fromEntries(fallback), brief: brief.enabled ? { model: brief.model } : null, describe: describe.enabled ? { model: describe.model } : null, whereami: whereami.enabled });
  });

  // A Claude-written situation brief of what the dashboard shows, on demand.
  // The key stays on this server; see server/brief.js for the cost and throttle.
  app.post('/api/brief', express.json({ limit: brief.bodyLimit }), brief.handler);
  // A Claude-written description of one clicked object; same key and limits.
  app.post('/api/describe', express.json({ limit: describe.bodyLimit }), describe.handler);
  // Where the visitor is, from their address (server/whereami.js), on request only.
  app.get('/api/whereami', whereami.handler);

  // One cheap call the browser makes every few seconds: health, counts and versions
  // of every source. The browser fetches a source's data only when its version moves.
  app.get('/api/status', (req, res) => {
    for (const p of pollers.values()) p.touch();
    res.set('Cache-Control', 'no-store');
    res.json({ serverTime: Date.now(), sources: [...pollers.values()].map((p) => p.status()) });
  });

  app.get('/api/sources/:id', (req, res) => {
    const poller = pollers.get(req.params.id);
    if (!poller) return res.status(404).json({ error: `Unknown source "${req.params.id}"` });
    poller.touch();
    res.set('Cache-Control', 'no-store');
    res.json({ status: poller.status(), data: poller.data });
  });

  // Lets the browser adjust what a source fetches, e.g. the aircraft bounding box.
  app.put('/api/sources/:id/options', express.json({ limit: '4kb' }), (req, res) => {
    const poller = pollers.get(req.params.id);
    if (!poller?.source.setOptions) return res.status(404).json({ error: `Source "${req.params.id}" has no options` });
    try {
      poller.source.setOptions(req.body ?? {});
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    poller.touch();
    res.json({ status: poller.status() });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  return { app, pollers };
}
