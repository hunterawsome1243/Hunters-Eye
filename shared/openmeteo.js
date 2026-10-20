// Open-Meteo's current-conditions grid: the pieces the server (server/overlays.js)
// and the browser (public/js/ui/overlays.js) share, so a browser that has to fetch
// the grid itself asks for exactly what the server would, in the same order and
// on the same budget.
//
// Open-Meteo's forecast API is keyless and free for non-commercial use, and it
// counts every location in a request as one call against its limits: 600 a
// minute, 5,000 an hour, 10,000 a day, per address, and refuses concurrent
// requests. One grid refresh asks for every point of a GRID_DEG grid between
// 80°S and 80°N (10° -> 612 points, 100 per request, one request at a time), so
// the default two-hour refresh spends ~7,300 of the day's calls, and only while
// someone is looking: the grid is fetched on the first request and refreshed on a
// request that finds it older than the refresh. A grid goes out in waves of
// WAVE_POINTS a minute, the tropics and mid-latitudes first, so one refresh never
// crowds the minute limit: the first answer is partial, and the poles follow a
// minute later. A 429 names the limit it hit, and that limit is left alone until
// its window has turned over, or for as long as a Retry-After header asks.

export const DEFAULT_URL = 'https://api.open-meteo.com/v1/forecast';
export const FIELDS = ['temperature', 'wind', 'windDir', 'rain', 'clouds'];
export const UNITS = { temperature: '°C', wind: 'km/h', rain: 'mm', clouds: '%' };
const CURRENT = 'temperature_2m,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover';
export const BATCH = 100; // points per request
export const WAVE_POINTS = 400; // points per minute, under Open-Meteo's 600 with room for whoever shares the address
export const WAVE_GAP_MS = 61_000;
export const FAIL_TTL_MS = 60_000;
export const TIMEOUT_MS = 15_000;
const LAT_MAX = 80; // the ice caps round the grid off and would cost a third more points

// Grid spacings whose columns close exactly round the planet (360 divides by them).
// Finer than 10° overspends the free allowance at the default refresh: the cost is
// points × (1440 ÷ OVERLAY_REFRESH_MIN) location-requests a day, against 10,000.
export const STEPS = [5, 6, 7.5, 9, 10, 12, 15, 18, 20, 30];

// The grid's points, south to north then west to east, row-major. An unlisted
// spacing snaps to the nearest listed one, so the last column always meets the first.
export function gridSpec(stepDeg = 10) {
  const asked = Number(stepDeg) || 10;
  const step = STEPS.reduce((best, s) => (Math.abs(s - asked) < Math.abs(best - asked) ? s : best));
  const lat0 = -Math.floor(LAT_MAX / step) * step;
  const rows = Math.floor((LAT_MAX - lat0) / step) + 1;
  const cols = Math.round(360 / step);
  return { lat0, lon0: -180, step, rows, cols };
}

export function gridPoints({ lat0, lon0, step, rows, cols }) {
  const pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push([lat0 + r * step, lon0 + c * step]);
  return pts;
}

// One request for a batch of points.
export function batchUrl(url, pts) {
  const q = new URLSearchParams({ latitude: pts.map((p) => p[0]).join(','), longitude: pts.map((p) => p[1]).join(','), current: CURRENT, timeformat: 'unixtime' });
  return `${url}?${q}`;
}

// Open-Meteo answers one location as an object and several as an array.
export function parseBatch(data, expected) {
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  if (data?.error) throw new Error(data.reason || 'Open-Meteo refused the request');
  if (list.length !== expected) throw new Error(`Open-Meteo answered ${list.length} of ${expected} points`);
  return list.map((p) => {
    const c = p.current ?? {};
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { temperature: n(c.temperature_2m), wind: n(c.wind_speed_10m), windDir: n(c.wind_direction_10m), rain: n(c.precipitation), clouds: n(c.cloud_cover) };
  });
}

// The order the points are asked for: the equator first, the poles last, so the
// first wave of a grid covers the latitudes where almost everyone looks.
export function fetchOrder(points) {
  return points.map((p, i) => i).sort((a, b) => Math.abs(points[a][0]) - Math.abs(points[b][0]) || a - b);
}

// Which of Open-Meteo's limits a refusal names: 'minutely', 'hourly', 'daily', or
// null for any other failure. (The 429 body reads "Daily API request limit
// exceeded. Please try again tomorrow." and the server and browser both keep a
// line of the body in the error's message.)
export function limitHit(err) {
  if (err?.status && err.status !== 429) return null;
  const m = /(minutely|hourly|daily) api request limit/i.exec(err?.message ?? '');
  return m ? m[1].toLowerCase() : null;
}

// How long to leave Open-Meteo alone after a failure. A named limit is a window:
// a minute's turns over in a minute and an hour's at the top of the hour. The
// day's window is not published (it may be a calendar day or a rolling one), so
// the day's limit is asked about once an hour, one refused request each time,
// rather than trusting a reset time and losing a whole day to a wrong guess.
// Retry-After wins when it asks for longer.
export function backoffMs(err, now = Date.now()) {
  const limit = limitHit(err);
  let wait = FAIL_TTL_MS;
  if (limit === 'minutely') wait = WAVE_GAP_MS;
  else if (limit === 'hourly') wait = 3_600_000 - (now % 3_600_000) + 60_000;
  else if (limit === 'daily') wait = 3_600_000;
  return Math.max(wait, err?.retryAfterMs || 0);
}

// A failure in a few plain words, for the menu and the readout, in place of the
// raw answer: a refusal's reason without its JSON, or just the status.
export function describeError(err) {
  const limit = limitHit(err);
  if (limit === 'daily') return "Open-Meteo's daily allowance for this address is used up (it says: try again tomorrow)";
  if (limit === 'hourly') return "Open-Meteo's hourly allowance for this address is used up until the top of the hour";
  if (limit === 'minutely') return "Open-Meteo's limit of 600 points a minute for this address was hit";
  const message = err?.message || String(err);
  const m = /^(.*answered HTTP \d+)(?::\s*(\{.*\}))?\s*$/s.exec(message);
  if (!m) return message;
  let reason = '';
  try { reason = JSON.parse(m[2] ?? '{}').reason ?? ''; } catch { /* not JSON after all */ }
  return reason ? `Open-Meteo refused the request: ${reason}` : m[1];
}

// The grid, kept and refreshed. `fetchJson(url, { timeoutMs })` fetches and parses
// one request and throws an Error with `status` and `retryAfterMs` on a refusal
// (server/lib/http.js on the server, a fetch wrapper in the browser). A `store`
// ({ load(), save(obj) }, localStorage in the browser) shares the grid and the
// budget between the pages of one browser: a reload or a second tab starts from
// the stored grid while it is younger than the refresh, continues a partial one,
// and waits for the minute slot another page has claimed instead of buying 400
// points of its own. The store is read before every decision, written before a
// wave (to claim the slot) and after it (to share what arrived), and always merged
// rather than overwritten, so a slower page never regresses what a faster one kept.
export function createGridLoader({ url, gridDeg, refreshMin, fetchJson, now = Date.now, onError = () => {}, store = null } = {}) {
  const enabled = !!url;
  const grid = gridSpec(gridDeg);
  const refreshMs = Math.max(Number(refreshMin) || 120, 15) * 60_000;
  const points = gridPoints(grid);
  const order = fetchOrder(points);
  let data = null; // the grid being served: { at, updated, grid, fields, done, total, partial, units, refreshMs }
  let next = null; // its replacement, built in waves while the old grid is still served
  let inflight = null; // the wave on its way
  let waveAt = 0; // when the last wave went out, from any page of this browser; the next waits WAVE_GAP_MS
  let retryAt = 0; // after a failure, no attempt before this
  let lastError = null;
  let borrowed = false; // lastError came from the store (another page was refused), not from a wave of our own

  function emptyGrid(t) {
    return { at: t, updated: t, grid, fields: Object.fromEntries(FIELDS.map((f) => [f, new Array(points.length).fill(null)])), done: 0, total: points.length, partial: true, units: UNITS, refreshMs };
  }
  const whole = (g) => !!g && !g.partial;
  const fresh = (g, t) => !!g && t - g.at < refreshMs;

  // What goes to the store: only a grid with points in it says anything, so an
  // empty one (a refused first wave) never travels with the time it was wanted.
  const pack = (g) => (g && g.done > 0 ? { at: g.at, updated: g.updated, done: g.done, fields: g.fields } : null);
  const valid = (p) => !!p && Number.isFinite(p.at) && Number.isInteger(p.done) && p.done > 0 && p.done <= points.length
    && FIELDS.every((f) => Array.isArray(p.fields?.[f]) && p.fields[f].length === points.length);
  const unpack = (p) => ({ ...emptyGrid(p.at), updated: p.updated, fields: p.fields, done: p.done, partial: p.done < points.length });
  // Further along than what this page holds: a whole grid by its date, a partial
  // one by its points; a whole grid is never traded for a partial one here (a
  // newer partial is its replacement, kept as `next`).
  const ahead = (p, g) => !g || (p.done === points.length ? !whole(g) || p.at > g.at : g.partial && (p.done > g.done || (p.done === g.done && p.at > g.at)));

  // Take from the store whatever is further along: the budget always (the minute
  // slot and any wait a refusal asked for belong to the whole browser, whatever
  // grid was stored), the grids when they fit this spacing.
  function merge() {
    let s = null;
    try { s = store?.load() ?? null; } catch { s = null; }
    if (!s || typeof s !== 'object') return;
    const t = now();
    waveAt = Math.max(waveAt, Number(s.waveAt) || 0);
    retryAt = Math.max(retryAt, Number(s.retryAt) || 0);
    if (borrowed && !s.error) { lastError = null; borrowed = false; } // the page that was refused has since succeeded
    if (s.error && retryAt > t && !lastError && !(data?.done > 0)) { // nothing to draw: say why, in the other page's words
      lastError = Object.assign(new Error(String(s.error.message)), s.error.status == null ? {} : { status: s.error.status });
      borrowed = true;
    }
    if (s.step !== grid.step || s.total !== points.length) return;
    for (const p of [s.data, s.next]) {
      if (!valid(p) || !fresh(p, t)) continue;
      if (ahead(p, data)) { data = unpack(p); next = null; }
      else if (whole(data) && p.done < points.length && p.at > data.at && ahead(p, next)) next = unpack(p);
    }
  }
  function keep() {
    const error = lastError ? { message: lastError.message, status: lastError.status ?? null } : null;
    try { store?.save({ step: grid.step, total: points.length, waveAt, retryAt, error, data: pack(data), next: pack(next) }); } catch { /* storage full or blocked */ }
  }
  const waitError = (t) => new Error(`the next wave of points goes out in ${Math.ceil(Math.max(0, Math.max(retryAt, waveAt + WAVE_GAP_MS) - t) / 1000)} s`);

  // One wave: the next WAVE_POINTS points of the grid, one request at a time (Open-
  // Meteo also refuses concurrent requests from one address: "Too many concurrent
  // requests"), each written into the grid as it comes back. The first failure ends
  // the wave, so a dead host costs one timeout, and what did arrive is kept.
  async function fetchWave(g) {
    const idx = order.slice(g.done, g.done + WAVE_POINTS);
    for (let i = 0; i < idx.length; i += BATCH) {
      const batch = idx.slice(i, i + BATCH);
      const parsed = parseBatch(await fetchJson(batchUrl(url, batch.map((j) => points[j])), { timeoutMs: TIMEOUT_MS }), batch.length);
      batch.forEach((j, k) => { for (const f of FIELDS) g.fields[f][j] = parsed[k][f]; });
      g.done += batch.length;
      g.partial = g.done < points.length;
      g.updated = now();
    }
    return g;
  }

  // The grid, refreshed when stale. The first request waits for the first wave and
  // gets a partial grid; later requests get what has arrived while the rest comes
  // in, a wave a minute. A complete grid is served until its replacement is
  // complete too. A wave that fails keeps what there is (marked stale or partial
  // in the answer) and is not tried again for a minute, or for as long as the
  // limit it hit or a Retry-After header asks: a rate-limited Open-Meteo is left
  // alone, not hammered.
  async function current() {
    if (!inflight) merge();
    const t = now();
    if (whole(data) && fresh(data, t)) return data;
    if (!inflight && t >= retryAt && t - waveAt >= WAVE_GAP_MS) {
      // A grid with no points yet is born now, not when it was first wanted (its
      // first wave may have been refused an hour ago); a partial one too old to
      // finish is started over, and so is a replacement abandoned that long (its
      // first wave hours old, it would be served as new and refreshed at once).
      if (data?.partial && (data.done === 0 || !fresh(data, t))) data = emptyGrid(t);
      if (next && (next.done === 0 || !fresh(next, t))) next = null;
      let g;
      if (data && data.partial) g = data;
      else if (whole(data)) g = next ?? (next = emptyGrid(t));
      else g = data = emptyGrid(t);
      waveAt = t;
      keep(); // the slot is claimed before the first request goes out, so another page waits for it
      inflight = fetchWave(g).then(() => {
        lastError = null;
        borrowed = false;
        if (g === next && !g.partial) { data = g; next = null; }
        merge();
        keep();
        return g;
      }).catch((err) => {
        retryAt = now() + backoffMs(err, now());
        lastError = err;
        borrowed = false;
        merge(); // another page may have finished what this wave was fetching
        if (whole(data) && fresh(data, now())) lastError = null;
        keep();
        onError(err);
        throw err;
      }).finally(() => { inflight = null; });
    }
    if (data && data.done > 0) {
      inflight?.catch(() => {}); // what there is goes out now; the failure is reported through lastError
      return data;
    }
    if (!inflight) throw lastError ?? waitError(t);
    return inflight.then(() => data);
  }

  return {
    enabled,
    grid,
    refreshMs,
    current,
    retryInMs: () => Math.max(0, retryAt - now()),
    get lastError() { return lastError; },
  };
}
