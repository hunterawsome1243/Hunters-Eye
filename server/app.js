import express from 'express';
import { fileURLToPath } from 'node:url';
import { SourcePoller } from './lib/poller.js';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

export function createApp(sources, pollerOptions) {
  const pollers = new Map(sources.map((s) => [s.id, new SourcePoller(s, pollerOptions)]));
  const app = express();
  app.disable('x-powered-by');

  app.use(express.static(root('public')));
  app.use('/vendor/leaflet', express.static(root('node_modules/leaflet/dist')));
  app.use('/vendor/satellite.js', express.static(root('node_modules/satellite.js/dist')));

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
