import './lib/env.js';
import { createApp } from './app.js';
import { sources } from './sources/index.js';

// Render (and similar hosts) route public traffic to 0.0.0.0 on $PORT, default 10000.
const onRender = process.env.RENDER === 'true';
const port = Number(process.env.PORT) || (onRender ? 10000 : 3000);
// Local only by default; set HOST=0.0.0.0 to reach it from other devices on your network.
const host = process.env.HOST || (onRender ? '0.0.0.0' : '127.0.0.1');
const { app, pollers } = createApp(sources);

const server = app.listen(port, host, () => {
  console.log(`Hunter's Eye running at http://localhost:${port}${host === '127.0.0.1' ? '' : ` (listening on ${host})`}`);
  for (const p of pollers.values()) {
    console.log(`  ${p.source.name.padEnd(16)} refresh every ${Math.round(p.intervalMs / 1000)}s${p.source.describe ? ` (${p.source.describe()})` : ''}`);
  }
});

function shutdown() {
  for (const p of pollers.values()) p.stop();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
