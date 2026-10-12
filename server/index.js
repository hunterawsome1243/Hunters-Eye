import './lib/env.js';
import { createApp } from './app.js';
import { sources } from './sources/index.js';

const port = Number(process.env.PORT) || 3000;
const { app, pollers } = createApp(sources);

const server = app.listen(port, () => {
  console.log(`Hunter's Eye running at http://localhost:${port}`);
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
