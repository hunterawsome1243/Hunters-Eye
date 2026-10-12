// End-to-end check: starts the server, opens the dashboard in headless Chromium,
// waits for every layer to load, clicks an item in each, and fails on any console
// error. Uses the live feeds by default; `--fake` swaps in scripts/fake-upstream.mjs.
//
//   npm run smoke            # live data (needs internet)
//   npm run smoke -- --fake  # offline stand-ins for the upstream APIs
//
// Needs a Chromium for Playwright: `npx playwright install chromium` once.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { startFakeUpstream } from './fake-upstream.mjs';

const fake = process.argv.includes('--fake');
const port = 3123;
const env = { ...process.env, PORT: String(port) };
let upstream;
if (fake) {
  upstream = await startFakeUpstream();
  const base = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(env, {
    USGS_URL: `${base}/usgs`,
    OPENSKY_URL: `${base}/opensky`,
    CELESTRAK_URL: `${base}/celestrak`,
    NWS_URL: `${base}/nws`,
    SATELLITE_CACHE_DIR: '',
  });
}

const server = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(d.toString()));
server.stderr.on('data', (d) => serverLog.push(d.toString()));
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => d.toString().includes('running at') && resolve());
  server.on('exit', (code) => reject(new Error(`server exited with ${code}\n${serverLog.join('')}`)));
});

const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));
if (fake) {
  // Map tiles come from the internet; serve blank ones so the run is fully offline.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  await page.route(/basemaps\.cartocdn\.com/, (r) => r.fulfill({ body: png, contentType: 'image/png' }));
}

const results = [];
let failed = false;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
}

try {
  await page.goto(`http://localhost:${port}/`);
  const layerIds = await page.evaluate(() => [...document.querySelectorAll('.chip .name')].map((n) => n.textContent));
  // Wait until every source has either data or an error.
  const deadline = Date.now() + (fake ? 30_000 : 120_000);
  let status;
  while (Date.now() < deadline) {
    status = await page.evaluate(() => fetch('/api/status').then((r) => r.json()));
    if (status.sources.every((s) => s.updatedAt || s.error)) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(6000); // let the browser pick up the data
  for (const s of status.sources) {
    const chip = await page.evaluate((name) => {
      const c = [...document.querySelectorAll('.chip')].find((x) => x.querySelector('.name').textContent === name);
      return { count: c.querySelector('.count').textContent, title: c.title };
    }, s.name);
    check(`${s.name}: source loaded`, !!s.updatedAt && !s.error, s.error || `${s.count} items upstream, ${chip.count} shown`);
  }
  check('layers present', layerIds.length === status.sources.length, layerIds.join(', '));

  const feedItems = await page.locator('#feed button').count();
  check('live feed has entries', feedItems > 0, `${feedItems} entries`);

  // Click the newest feed entry of each layer and check the detail panel opens.
  for (const s of status.sources) {
    const opened = await page.evaluate(async (id) => {
      const app = window.__huntersEye;
      return app ? app.selectFirst(id) : false;
    }, s.id);
    await page.waitForTimeout(400);
    const title = (await page.locator('#detail:not([hidden]) .detail-title').textContent().catch(() => '')) || '';
    check(`${s.name}: clicking an item opens details`, opened && title.length > 0, title.trim());
  }

  await page.waitForTimeout(1500);
  mkdirSync('docs', { recursive: true });
  await page.screenshot({ path: `docs/screenshot${fake ? '-fake' : ''}.png` });
} catch (err) {
  check('smoke run', false, err.message);
} finally {
  check('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  const serverErrors = serverLog.join('').split('\n').filter((l) => /error|warn|\[\w+\]/i.test(l));
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '));
  await browser.close();
  server.kill();
  upstream?.close();
  console.log(results.join('\n'));
  process.exit(failed ? 1 : 0);
}
