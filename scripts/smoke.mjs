// End-to-end check: starts the server, opens the dashboard in headless Chromium,
// waits for every layer to load, clicks an item in each, exercises the globe
// (clusters, ground track, filters, spin) and fails on any console error.
// Uses the live feeds by default; `--fake` swaps in scripts/fake-upstream.mjs.
//
//   npm run smoke            # live data (needs internet)
//   npm run smoke -- --fake  # offline stand-ins for the upstream APIs and tiles
//   npm run smoke -- --fake --server-blocked   # the server can't reach OpenSky and
//                            # CelesTrak, so the browser fallback must fill in
//   npm run smoke -- --fake --browser-blocked  # ...and the browser is refused too (CORS)
//   npm run smoke -- --fake --shots            # also save docs/globe-*.png and a phone run
//
// Needs a Chromium for Playwright: `npx playwright install chromium` once. The globe
// needs WebGL2; headless Chromium gets it from SwiftShader (software), so frames are
// slow and every wait here is event-based, never a frame-rate assertion.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { startFakeUpstream } from './fake-upstream.mjs';
import { fallbackStyle } from '../public/js/globe/style.js';

const fake = process.argv.includes('--fake');
const shots = process.argv.includes('--shots');
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
    WHEREAMI_URL: `${base}/whereami/{ip}`,
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

const launchOpts = { args: ['--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launchOpts);
const consoleErrors = [];
// With --browser-blocked, Chromium itself logs the refused cross-origin requests.
const expectedError = (m) => browserBlocked && (m.text().includes('/nocors/') || m.location().url.includes('/nocors/'));

async function openPage(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...options });
  page.on('console', (m) => m.type() === 'error' && !expectedError(m) && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  if (fake) {
    // The basemap and imagery come from the internet. Serve the app's own offline
    // style (dark sphere + continents) for the style URL and empty tiles for the rest.
    await page.route(/tiles\.openfreemap\.org\/styles/, (r) => r.fulfill({ json: fallbackStyle() }));
    await page.route(/tiles\.openfreemap\.org\/(planet|fonts|sprites|natural_earth)|tiles\.maps\.eox\.at|gibs\.earthdata\.nasa\.gov/, (r) => r.fulfill({ status: 204 }));
  }
  return page;
}
const page = await openPage();

// Wait for the globe to finish drawing (sources loaded, tiles in). Capped: on
// SwiftShader a frame is slow, and some sources never stop updating.
const idle = (p = page, ms = 15_000) => p.evaluate((ms) => new Promise((resolve) => {
  const m = window.__huntersEye.map;
  const t = setTimeout(() => resolve('timeout'), ms);
  m.once('idle', () => { clearTimeout(t); resolve('idle'); });
  m.triggerRepaint();
}), ms);
const ready = (p = page) => p.waitForFunction(() => window.__huntersEye?.globe?.ready === true, null, { timeout: 30_000 });
const evalMap = (fn, arg) => page.evaluate(fn, arg);

const results = [];
let failed = false;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
}

try {
  await page.goto(`http://localhost:${port}/?spin=off`);
  await ready();
  await idle();
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
  const globeState = await evalMap((fake) => {
    const { map, globe } = window.__huntersEye;
    return {
      ready: globe.ready, canvas: !!map.getCanvas(), imagery: !!map.getLayer('he-imagery'),
      projection: Array.isArray(map.getProjection()?.type), land: !!map.getLayer('he-land-fill'), fake,
      slots: ['shapes', 'tracks', 'planes', 'points', 'labels', 'top'].every((t) => !!map.getLayer(`he-slot-${t}`)),
    };
  }, fake);
  check('globe drawn by MapLibre', globeState.ready && globeState.canvas && globeState.imagery && globeState.projection && globeState.slots && (!fake || globeState.land), JSON.stringify(globeState));

  // The feed opens on the Proximity tab; the Live tab is the newest-first list these checks expect.
  await page.locator('#feed-tab-live').click();
  await page.waitForTimeout(100);
  const feedItems = await page.locator('#feed button').count();
  check('live feed has entries', feedItems > 0, `${feedItems} entries`);

  // Click the newest feed entry of each layer and check the detail panel opens.
  for (const s of status.sources.filter((x) => hasData(x.id))) {
    const opened = await page.evaluate(async (id) => {
      const app = window.__huntersEye;
      return app ? app.selectFirst(id) : false;
    }, s.id);
    await idle();
    const title = (await page.locator('#detail:not([hidden]) .detail-title').textContent().catch(() => '')) || '';
    check(`${s.name}: clicking an item opens details`, opened && title.length > 0, title.trim());
  }

  // The satellite ground track is one line that wraps around the globe.
  if (hasData('satellites')) {
    const track = await evalMap(async () => {
      const src = window.__huntersEye.map.getSource('he-satellites-track');
      if (!src) return { error: 'no track source' };
      const data = await src.getData();
      const next = data.features.find((f) => f.properties.phase === 'next');
      if (!next) return { error: 'no next-orbit feature' };
      const lons = next.geometry.coordinates.map(([lon]) => lon);
      const maxStep = Math.max(...lons.slice(1).map((l, i) => Math.abs(l - lons[i])));
      return { maxStep, span: Math.max(...lons) - Math.min(...lons), points: lons.length };
    });
    check('Satellites: ground track wraps around the globe', !track.error && track.maxStep < 180 && track.span > 300, JSON.stringify(track));
  }
  await page.keyboard.press('Escape');

  // The magnitude slider filters on the GPU, so no quake circle may remain at 7+.
  // (Whole-viewport queries miss points on the globe below z3, so look from z4.)
  if (hasData('earthquakes')) {
    await evalMap(() => window.__huntersEye.map.jumpTo({ center: [142, 38], zoom: 4 }));
    await idle();
    const slider = page.locator('.filter input[type="range"]').first();
    await slider.fill('7');
    await idle();
    const left = await evalMap(() => window.__huntersEye.map.queryRenderedFeatures({ layers: ['he-earthquakes'] }).length);
    await slider.fill('2.5');
    await idle();
    const back = await evalMap(() => window.__huntersEye.map.queryRenderedFeatures({ layers: ['he-earthquakes'] }).length);
    check('Earthquakes: magnitude filter hides circles', left === 0 && back > 0, `${left} at 7+, ${back} at 2.5+`);
  }

  // A real click on the canvas: focus a plane (it ends up mid-map), close the
  // panel, then click the middle of the map and expect that plane again.
  if (hasData('aircraft') && status.sources.some((s) => s.id === 'aircraft' && (s.updatedAt || viaBrowser(s.id)))) {
    // From space, planes are density bubbles; closer in, individual icons.
    await evalMap(() => window.__huntersEye.map.jumpTo({ center: [-20, 25], zoom: 2 }));
    await idle();
    const far = await evalMap(() => ({
      clusters: window.__huntersEye.map.queryRenderedFeatures({ layers: ['he-aircraft-cluster'] }).length,
      planes: window.__huntersEye.map.queryRenderedFeatures({ layers: ['he-aircraft'] }).length,
    }));
    await evalMap(() => window.__huntersEye.map.jumpTo({ center: [0, 48], zoom: 7 }));
    await idle();
    const near = await evalMap(() => ({
      clusters: window.__huntersEye.map.queryRenderedFeatures({ layers: ['he-aircraft-cluster'] }).length,
      planes: window.__huntersEye.map.queryRenderedFeatures({ layers: ['he-aircraft'] }).length,
    }));
    // Lone planes with no neighbour within 36 px stay single icons, so from space
    // most of what shows must be bubbles; up close there are no bubbles at all.
    check('Aircraft: clustered from space, individual planes up close',
      far.clusters > 0 && far.planes <= far.clusters && near.clusters === 0 && near.planes > 0,
      `z2 ${JSON.stringify(far)}, z7 ${JSON.stringify(near)}`);

    // A real click on the canvas: focus a plane (it ends up mid-map), close the
    // panel, then click the middle of the map and expect that plane again.
    await evalMap(() => window.__huntersEye.selectFirst('aircraft'));
    await idle();
    const want = await page.locator('#detail .detail-title').textContent();
    await page.keyboard.press('Escape');
    await idle();
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const got = (await page.locator('#detail:not([hidden]) .detail-title').textContent().catch(() => '')) || '';
    check('Aircraft: clicking a plane on the map opens it', got === want, `${want} -> ${got}`);

    // Map controls and point markers must not be swallowed by planes underneath.
    const zoomBefore = await evalMap(() => window.__huntersEye.map.getZoom());
    await page.locator('.maplibregl-ctrl-zoom-in').click();
    await page.waitForFunction((before) => Math.abs(window.__huntersEye.map.getZoom() - before - 1) < 0.01, zoomBefore, { timeout: 5000 }).catch(() => {});
    const zoomAfter = await evalMap(() => window.__huntersEye.map.getZoom());
    check('Zoom button works over aircraft', Math.abs(zoomAfter - zoomBefore - 1) < 0.01, `${zoomBefore} -> ${zoomAfter}`);

    const quake = await evalMap(() => {
      const app = window.__huntersEye;
      app.selectFirst('earthquakes');
      return document.querySelector('#detail .detail-title').textContent;
    });
    await idle();
    await page.keyboard.press('Escape');
    await idle();
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

  // "You are here": the proximity feed (the default tab) asked the server at start and
  // dropped the marker; the detail card measures from it (the fake places every visitor
  // in Denver), and the proximity feed lists the nearest things first with distances.
  if (fake) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.you', { timeout: 10_000 });
    await idle();
    const label = await page.locator('.you-label').textContent();
    await evalMap(() => window.__huntersEye.selectFirst('earthquakes'));
    await page.waitForTimeout(300);
    const fromYou = await page.evaluate(() => [...document.querySelectorAll('#detail dt')].find((dt) => dt.textContent === 'From you')?.nextElementSibling?.textContent ?? '');
    check('You are here: marker placed at start and the card measures from it', label === 'You · Denver' && /km/.test(fromYou), `${label}; ${fromYou}`);
    await page.keyboard.press('Escape');
    await page.locator('#feed-tab-near').click();
    await page.waitForSelector('#feed .dist', { timeout: 5_000 });
    const dists = await page.$$eval('#feed .dist', (els) => els.map((e) => parseFloat(e.textContent.replace(/,/g, ''))));
    const ascending = dists.every((d, i) => Number.isFinite(d) && (i === 0 || d >= dists[i - 1]));
    check('Proximity feed: nearest first, a distance on every row', dists.length > 1 && ascending, `${dists.length} rows, first ${dists[0]} km, last ${dists[dists.length - 1]} km`);
    const reach = await page.locator('#feed-count').textContent();
    check('Proximity feed: the heading says how far it reaches', /≤ [\d,]+ km/.test(reach), reach);
    await page.locator('.he-ctrl-here').click(); // forget again
    check('You are here: pressing again removes the marker', (await page.locator('.you').count()) === 0);
    await page.waitForTimeout(100);
    check('Proximity feed: without a place it offers Find me', (await page.locator('#feed .feed-locate-btn').count()) === 1);
    await page.locator('#feed .feed-locate-btn').click();
    await page.waitForSelector('.you', { timeout: 10_000 });
    check('Proximity feed: Find me places the marker again', (await page.locator('.you').count()) === 1);
    await page.locator('#feed-tab-live').click();
  }

  if (!fake) {
    const labels = await evalMap(() => !!window.__huntersEye.map.getLayer('he-satellites-label'));
    check('Satellites: labels exist with the live basemap', labels);
  }

  // Reduced motion: the ambient spin never starts.
  const quiet = await openPage({ reducedMotion: 'reduce' });
  await quiet.goto(`http://localhost:${port}/`);
  await ready(quiet);
  const lng0 = await quiet.evaluate(() => window.__huntersEye.map.getCenter().lng);
  await quiet.waitForTimeout(3000);
  const lng1 = await quiet.evaluate(() => window.__huntersEye.map.getCenter().lng);
  check('Reduced motion stops the spin', lng0 === lng1, `${lng0} -> ${lng1}`);
  await quiet.close();

  await idle();
  mkdirSync('docs', { recursive: true });
  const mode = browserBlocked ? '-browser-blocked' : serverBlocked ? '-server-blocked' : fake ? '-fake' : '';
  await page.screenshot({ path: `docs/screenshot${mode}.png` });

  if (shots) {
    await page.keyboard.press('Escape');
    await evalMap(() => window.__huntersEye.map.jumpTo({ center: [-20, 25], zoom: 1.8, pitch: 0, bearing: 0 }));
    await idle();
    await page.screenshot({ path: 'docs/globe-space.png' });
    await evalMap(() => window.__huntersEye.map.jumpTo({ center: [-97, 36], zoom: 5.5, pitch: 50, bearing: 20 }));
    await idle();
    await page.screenshot({ path: 'docs/globe-region.png' });

    const phone = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.goto(`http://localhost:${port}/?spin=off`);
    await ready(phone);
    await idle(phone);
    await phone.evaluate(() => window.__huntersEye.selectFirst('earthquakes'));
    await idle(phone);
    const controlsHidden = await phone.evaluate(() => getComputedStyle(document.querySelector('.maplibregl-ctrl-bottom-right')).visibility === 'hidden');
    check('Phone: bottom controls hide while the detail sheet is open', controlsHidden);
    await phone.screenshot({ path: 'docs/screenshot-phone.png' });
    await phone.close();
  }
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
