import { ANONYMOUS_CREDITS, delayFor, normalizeBbox, normalizeStates, statesQuery } from '../../shared/opensky.js';
import { GROUPS, MAX_AGE_MS, groupUrl, mergeGroups, parseTle } from '../../shared/celestrak.js';

// Browser fallback. Some hosts can't reach every feed: from Render, OpenSky and
// CelesTrak time out, most likely because they block the shared addresses Render
// sends from. When the server reports a source failing and has no data for it,
// the browser fetches that source itself, straight from the provider, on the same
// budget the server would use but counted against the viewer's own connection.
// It stops as soon as the server has data again. It only works where the provider
// allows cross-origin requests (CORS); when it doesn't, the chip says so.

const NETWORK_RETRY_MS = 10 * 60_000; // a CORS block won't clear by retrying soon
const KEY = 'huntersEye.fallback.';

const PROVIDERS = { aircraft: 'OpenSky', satellites: 'CelesTrak' };

// localStorage when the browser allows it, else memory, so caching and budgets
// still hold within the page.
function browserStore() {
  try {
    const s = globalThis.localStorage;
    s.getItem(KEY);
    return s;
  } catch {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
  }
}

function load(store, key) {
  try {
    return JSON.parse(store.getItem(KEY + key) ?? 'null');
  } catch {
    return null;
  }
}

function save(store, key, value) {
  try {
    store.setItem(KEY + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the next page load just starts without the cache.
  }
}

async function get(fetchFn, url) {
  let res;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout?.(30_000) });
  } catch (err) {
    const e = new Error(
      err?.name === 'TimeoutError'
        ? 'no answer within 30 s'
        : 'refused or unreachable (the site may not accept requests from other web pages)',
    );
    e.retryAfterMs = NETWORK_RETRY_MS;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    // Only readable when the provider exposes it to cross-origin pages.
    const after = Number(res.headers.get('x-rate-limit-retry-after-seconds') ?? res.headers.get('retry-after'));
    if (after > 0) e.retryAfterMs = after * 1000;
    throw e;
  }
  return res;
}

// CelesTrak: same rules as server/sources/satellites.js. Each group is downloaded
// at most once per 2-hour update and cached in localStorage; a 403 means "nothing
// newer yet" and keeps the cache. Without a cache, retry every 10 minutes, which
// stays far below CelesTrak's limit of 50 errors in 2 hours.
export function satellitesSource(url, { fetch: fetchFn, store, now }) {
  const lastAsked = (c) => Math.max(c?.downloadedAt ?? 0, c?.checkedAt ?? 0);
  const waitFor = (c) => (c?.text ? MAX_AGE_MS : NETWORK_RETRY_MS);

  async function loadGroup(group) {
    const cached = load(store, `celestrak.${group}`);
    const t = now();
    if (cached && t - lastAsked(cached) < waitFor(cached)) {
      if (cached.text) return cached;
      throw new Error(cached.error || 'waiting to retry');
    }
    try {
      const text = await (await get(fetchFn, groupUrl(url, group))).text();
      if (!parseTle(text, group).length) throw new Error('no element sets in the response');
      const entry = { text, downloadedAt: t, checkedAt: t };
      save(store, `celestrak.${group}`, entry);
      return entry;
    } catch (err) {
      const error = err.status === 403 && cached?.text ? null : err.message;
      save(store, `celestrak.${group}`, { ...cached, checkedAt: t, error });
      if (cached?.text) return { ...cached, error };
      throw err;
    }
  }

  return {
    id: 'satellites',
    intervalMs: () => MAX_AGE_MS,
    errorRetryMs: NETWORK_RETRY_MS,
    async fetch() {
      const results = [];
      const errors = [];
      for (const group of GROUPS) {
        try {
          results.push({ group, ...(await loadGroup(group)) });
        } catch (err) {
          errors.push(`${group}: ${err.message}`);
        }
      }
      if (!results.length) {
        const messages = new Set(errors.map((e) => e.replace(/^\w+: /, '')));
        throw new Error(messages.size === 1 ? [...messages][0] : errors.join('; '));
      }
      const satellites = mergeGroups(results);
      const oldest = Math.min(...results.map((r) => r.downloadedAt));
      const problems = [...errors, ...results.filter((r) => r.error).map((r) => `${r.group}: ${r.error}`)];
      const nextCheck = Math.min(...GROUPS.map((g) => {
        const c = load(store, `celestrak.${g}`);
        return lastAsked(c) + waitFor(c);
      }));
      return {
        data: { fetchedAt: oldest, satellites },
        count: satellites.length,
        updatedAt: oldest,
        note: `Element sets downloaded ${new Date(oldest).toISOString().slice(0, 16).replace('T', ' ')} UTC.${problems.length ? ` Using cached data: ${problems.join('; ')}.` : ''}`,
        nextDelayMs: Math.max(60_000, nextCheck - now() + 1000),
      };
    },
  };
}

// OpenSky: anonymous only, since the API client secret must stay on the server.
// That is 400 credits a day for the viewer's connection, so a whole-world refresh
// every ~17 minutes, or faster for a small "only aircraft in current view" box.
// The last request time is shared by all tabs through localStorage, so reloading
// or opening a second tab doesn't spend extra credits.
export function aircraftSource(url, { fetch: fetchFn, store, now, options }) {
  const RELOAD_GAP_MS = 60_000;
  const currentBox = () => {
    try {
      return normalizeBbox(options()?.bbox);
    } catch {
      return null;
    }
  };

  return {
    id: 'aircraft',
    intervalMs: () => delayFor(currentBox(), ANONYMOUS_CREDITS),
    errorRetryMs: 2 * 60_000,
    // How long to hold off before fetching. A page with no aircraft yet may fetch
    // soon after another tab did, but never inside a 429 back-off and never more
    // than once a minute; after that, every tab waits for the shared next slot.
    deferMs(hasData) {
      const s = load(store, 'opensky') ?? {};
      const ready = hasData ? (s.nextAt ?? 0) : (s.lastAt ?? 0) + RELOAD_GAP_MS;
      return Math.max(0, (s.retryAt ?? 0) - now(), ready - now());
    },
    async fetch() {
      const box = currentBox();
      const t = now();
      const delay = delayFor(box, ANONYMOUS_CREDITS);
      save(store, 'opensky', { lastAt: t, nextAt: t + delay });
      let res;
      try {
        res = await get(fetchFn, `${url}/states/all?${statesQuery(box)}`);
      } catch (err) {
        if (err.status === 429) {
          err.retryAfterMs ||= 60 * 60_000;
          err.message = 'OpenSky credit limit reached for your connection today; waiting before retrying';
          save(store, 'opensky', { lastAt: t, nextAt: t + delay, retryAt: t + err.retryAfterMs });
        }
        throw err;
      }
      const data = { ...normalizeStates(await res.json()), bbox: box };
      return {
        data,
        count: data.states.length,
        updatedAt: now(),
        note: `Covers the ${box ? 'map view' : 'whole world'}. Anonymous OpenSky access from your browser, ${ANONYMOUS_CREDITS} credits a day.`,
        nextDelayMs: delay,
      };
    },
  };
}

const SOURCES = { aircraft: aircraftSource, satellites: satellitesSource };

// Runs one source in the browser and keeps a status shaped like the server's.
class Runner {
  constructor(impl, provider, { onData, onChange, now }) {
    Object.assign(this, { impl, provider, onData, onChange, now });
    this.active = false;
    this.generation = 0;
    this.timer = null;
    this.serverError = null;
    this.state = { error: null, note: null, count: 0, updatedAt: null, nextAt: null };
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.generation++;
    this.schedule(0);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = null;
    this.state.nextAt = null;
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.state.nextAt = this.now() + ms;
    this.timer = setTimeout(() => this.run(), ms);
  }

  async run() {
    const gen = this.generation;
    const defer = this.impl.deferMs?.(!!this.state.updatedAt) ?? 0;
    if (defer > 0) return this.schedule(defer);
    let delay;
    try {
      const r = await this.impl.fetch();
      if (gen !== this.generation) return;
      this.onData(this.impl.id, r.data);
      Object.assign(this.state, { error: null, note: r.note, count: r.count, updatedAt: r.updatedAt });
      delay = r.nextDelayMs;
    } catch (err) {
      if (gen !== this.generation) return;
      this.state.error = err.message;
      delay = Math.max(this.impl.errorRetryMs, err.retryAfterMs || 0);
      console.warn(`[${this.impl.id}] browser fallback: ${err.message}`);
    }
    this.schedule(delay);
    this.onChange();
  }

  // The server's status for this source, with the browser's results in place of its own.
  status(server) {
    const st = this.state;
    const why = `the server can't reach ${this.provider}${this.serverError ? ` (${this.serverError})` : ''}`;
    return {
      ...server,
      ok: !st.error && !!st.updatedAt,
      loading: !st.error && !st.updatedAt,
      error: st.error ? `The server can't reach ${this.provider}, and your browser's request failed too: ${st.error}` : null,
      note: [st.note, `Loaded by your browser because ${why}.`].filter(Boolean).join(' '),
      count: st.count,
      updatedAt: st.updatedAt,
      nextAt: st.nextAt,
      intervalMs: this.impl.intervalMs(),
      via: 'browser',
    };
  }
}

// urls: { sourceId: providerUrl } from /api/config. onData(id, data) gets data in
// the same shape as /api/sources/<id>; onChange() fires after each browser fetch.
export function createFallbacks(urls = {}, {
  onData,
  onChange = () => {},
  options = () => ({}),
  fetch: fetchFn = (...args) => globalThis.fetch(...args),
  store = browserStore(),
  now = Date.now,
} = {}) {
  const runners = new Map();
  for (const [id, url] of Object.entries(urls)) {
    if (!SOURCES[id] || !url) continue;
    const impl = SOURCES[id](url, { fetch: fetchFn, store, now, options: () => options(id) });
    runners.set(id, new Runner(impl, PROVIDERS[id], { onData, onChange, now }));
  }

  return {
    // The status to show for a server source: the server's own, or the browser's
    // while it stands in. Starts the browser fetching when the server has failed
    // with no data, and stops it once the server has data.
    status(s) {
      const r = runners.get(s.id);
      if (!r) return s;
      if (s.updatedAt) {
        r.stop();
        return s;
      }
      if (s.error) {
        r.serverError = s.error;
        r.start();
      }
      return r.active ? r.status(s) : s;
    },
    stop() {
      for (const r of runners.values()) r.stop();
    },
  };
}
