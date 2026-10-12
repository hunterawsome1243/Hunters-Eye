// End-to-end check: starts the server, opens the dashboard in headless Chromium,
// waits for every layer to load, clicks an item in each, and fails on any console
// error. Uses the live feeds by default; `--fake` swaps in scripts/fake-upstream.mjs.
//
//   npm run smoke            # live data (needs internet)
//   npm run smoke -- --fake  # offline stand-ins for the upstream APIs
//   npm run smoke -- --fake --server-blocked   # the server can't reach OpenSky and
//                            # CelesTrak, so the browser fallback must fill in
//   npm run smoke -- --fake --browser-blocked  # ...and the browser is refused too (CORS)
//
// Needs a Chromium for Playwright: `npx playwright install chromium` once.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { startFakeUpstream } from './fake-upstream.mjs';

const fake = process.argv.includes('--fake');
const browserBlocked = process.argv.includes('--browser-blocked');
const serverBlocked = browserBlocked || process.argv.includes('--server-blocked');
if (serverBlocked && !fake) throw new Error('--server-blocked and --browser-blocked need --fake');
const FALLBACK_IDS = ['aircraft', 'satellites']; // sources the browser can fetch itself
const viaBrowser = (id) => serverBlocked && FALLBACK_IDS.includes(id);
const hasData = (id) => !(browserBlocked && FALLBACK_IDS.includes(id));
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
    NWS_ZONE_BASE: base,
    CACHE_DIR: '',
    AIRCRAFT_INTERVAL_SEC: '3',
  });
  if (serverBlocked) {
    // Nothing listens on port 9, so the server's requests fail at once, like a
    // host whose address the provider blocks. The browser gets the real stand-ins.
    const browserBase = browserBlocked ? `${base}/nocors` : base;
    Object.assign(env, {
      OPENSKY_URL: 'http://127.0.0.1:9/opensky',
      CELESTRAK_URL: 'http://127.0.0.1:9/celestrak',
      OPENSKY_BROWSER_URL: `${browserBase}/opensky`,
      CELESTRAK_BROWSER_URL: `${browserBase}/celestrak`,
    });
  }
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
// With --browser-blocked, Chromium itself logs the refused cross-origin requests.
const expectedError = (m) => browserBlocked && (m.text().includes('/nocors/') || m.location().url.includes('/nocors/'));
page.on('console', (m) => m.type() === 'error' && !expectedError(m) && consoleErrors.push(m.text()));
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
    const chip = await page.evaluate((id) => {
      const c = document.querySelector(`.chip[data-id="${id}"]`);
      return c
        ? { count: c.querySelector('.count').textContent, ago: c.querySelector('.ago').textContent, title: c.title, error: c.classList.contains('error') }
        : { count: 'no chip', ago: '', title: '', error: false };
    }, s.id);
    if (!viaBrowser(s.id)) {
      check(`${s.name}: source loaded`, !!s.updatedAt && !s.error, s.error || `${s.count} items upstream, ${chip.count} shown`);
    } else if (hasData(s.id)) {
      const shown = Number(chip.count.replace(/\D/g, ''));
      check(`${s.name}: browser fallback loaded it`, !!s.error && shown > 0 && chip.ago.includes('via browser') && !chip.error, `${chip.count} shown, ${chip.ago}`);
    } else {
      const why = chip.title.split('\n').find((l) => l.startsWith('Error:')) || chip.title;
      check(`${s.name}: chip explains both failures`, chip.error && why.includes("your browser's request failed too"), why);
    }
  }
  check('layers present', layerIds.length === status.sources.length, layerIds.join(', '));

  const feedItems = await page.locator('#feed button').count();
  check('live feed has entries', feedItems > 0, `${feedItems} entries`);

  // Click the newest feed entry of each layer and check the detail panel opens.
  for (const s of status.sources.filter((x) => hasData(x.id))) {
    const opened = await page.evaluate(async (id) => {
      const app = window.__huntersEye;
      return app ? app.selectFirst(id) : false;
    }, s.id);
    await page.waitForTimeout(400);
    const title = (await page.locator('#detail:not([hidden]) .detail-title').textContent().catch(() => '')) || '';
    check(`${s.name}: clicking an item opens details`, opened && title.length > 0, title.trim());
  }

  // A real click on the canvas: focus a plane (it ends up mid-map), close the
  // panel, then click the middle of the map and expect that plane again.
  if (hasData('aircraft') && status.sources.some((s) => s.id === 'aircraft' && (s.updatedAt || viaBrowser(s.id)))) {
    await page.evaluate(() => window.__huntersEye.selectFirst('aircraft'));
    await page.waitForTimeout(1500);
    const want = await page.locator('#detail .detail-title').textContent();
    await page.keyboard.press('Escape');
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const got = (await page.locator('#detail:not([hidden]) .detail-title').textContent().catch(() => '')) || '';
    check('Aircraft: clicking a plane on the map opens it', got === want, `${want} -> ${got}`);

    // Map controls and point markers must not be swallowed by planes underneath.
    const zoomBefore = await page.evaluate(() => window.__huntersEye.map.getZoom());
    await page.locator('.leaflet-control-zoom-in').click();
    await page.waitForTimeout(600);
    const zoomAfter = await page.evaluate(() => window.__huntersEye.map.getZoom());
    check('Zoom button works over aircraft', zoomAfter === zoomBefore + 1, `${zoomBefore} -> ${zoomAfter}`);

    const quake = await page.evaluate(() => {
      const app = window.__huntersEye;
      app.selectFirst('earthquakes');
      return document.querySelector('#detail .detail-title').textContent;
    });
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const clicked = (await page.locator('#detail:not([hidden]) .detail-title').textContent().catch(() => '')) || '';
    check('Earthquake click wins over aircraft', clicked === quake, `${quake} -> ${clicked}`);

    // The view filter should reach the server and narrow what it fetches.
    await page.locator('.filter label', { hasText: 'Only aircraft in current view' }).locator('input').check();
    let note = '';
    for (let i = 0; i < (fake && !serverBlocked ? 10 : 0); i++) {
      await page.waitForTimeout(1000);
      const s = await page.evaluate(() => fetch('/api/status').then((r) => r.json()));
      note = s.sources.find((x) => x.id === 'aircraft').note || '';
      if (note.includes('map view')) break;
    }
    if (fake && !serverBlocked) check('Aircraft: view filter narrows the server query', note.includes('map view'), note);
    if (serverBlocked) {
      const bbox = await page.evaluate(() => window.__huntersEye.layers.find((l) => l.id === 'aircraft').fetchOptions().bbox);
      check('Aircraft: view filter reaches the browser fallback', !!bbox, JSON.stringify(bbox));
    }
  }

  await page.waitForTimeout(1500);
  mkdirSync('docs', { recursive: true });
  const mode = browserBlocked ? '-browser-blocked' : serverBlocked ? '-server-blocked' : fake ? '-fake' : '';
  await page.screenshot({ path: `docs/screenshot${mode}.png` });
} catch (err) {
  check('smoke run', false, err.message);
} finally {
  check('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  // In the blocked modes the server is expected to log its failed attempts.
  const expectedLog = (l) => serverBlocked && FALLBACK_IDS.some((id) => l.startsWith(`[${id}]`));
  const serverErrors = serverLog.join('').split('\n').filter((l) => /error|warn|\[\w+\]/i.test(l) && !expectedLog(l));
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '));
  await browser.close();
  server.kill();
  upstream?.close();
  console.log(results.join('\n'));
  process.exit(failed ? 1 : 0);
}
