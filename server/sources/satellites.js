import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, getText } from '../lib/http.js';

// CelesTrak GP element sets (TLE format). The browser propagates positions itself
// with satellite.js, so the server only needs fresh elements now and then.
// Docs: https://celestrak.org/NORAD/documentation/gp-data-formats.php
// CelesTrak updates GP data about every 2 hours and, since March 2026, answers a
// repeat download before the next update with HTTP 403. So each group is cached
// on disk and re-downloaded only when it is over 2 hours old, also across restarts.
const BASE = process.env.CELESTRAK_URL || 'https://celestrak.org/NORAD/elements/gp.php';
const CACHE_DIR = process.env.CACHE_DIR ?? fileURLToPath(new URL('../../data/cache', import.meta.url));
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

// Space stations (ISS, Tiangong and visiting craft) plus the ~150 brightest objects.
export const GROUPS = ['STATIONS', 'VISUAL'];

export const NOTABLE = {
  25544: 'ISS',
  48274: 'Tiangong',
  20580: 'Hubble',
  27386: 'Envisat',
  33591: 'NOAA 19',
};

export function parseTle(text, group) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const sats = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
    const id = l1.slice(2, 7).trim();
    sats.push({ id, name: name.replace(/^0 /, '').trim(), line1: l1, line2: l2, group, notable: NOTABLE[id] ?? null });
    i += 2;
  }
  return sats;
}

const memory = new Map(); // group -> { text, fetchedAt } when disk caching is off

function readCache(group) {
  if (!CACHE_DIR) return memory.get(group) ?? null;
  const file = join(CACHE_DIR, `celestrak-${group.toLowerCase()}.tle`);
  try {
    return { text: readFileSync(file, 'utf8'), fetchedAt: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

function writeCache(group, text) {
  if (!CACHE_DIR) return memory.set(group, { text, fetchedAt: Date.now() });
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `celestrak-${group.toLowerCase()}.tle`), text);
}

function touchCache(group) {
  if (!CACHE_DIR) {
    const m = memory.get(group);
    if (m) m.fetchedAt = Date.now();
    return;
  }
  const now = new Date();
  try {
    utimesSync(join(CACHE_DIR, `celestrak-${group.toLowerCase()}.tle`), now, now);
  } catch {
    /* nothing cached to touch */
  }
}

async function loadGroup(group) {
  const cached = readCache(group);
  if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return { ...cached, from: 'cache' };
  try {
    const text = await getText(`${BASE}?GROUP=${group}&FORMAT=TLE`, { timeoutMs: 30_000 });
    if (!parseTle(text, group).length) throw new Error(`CelesTrak returned no element sets for ${group}`);
    writeCache(group, text);
    return { text, fetchedAt: Date.now(), from: 'network' };
  } catch (err) {
    if (!cached) throw err;
    // 403 means "no newer data since your last download": wait for the next update.
    if (err instanceof HttpError && err.status === 403) touchCache(group);
    return { ...cached, from: 'stale', error: err.message };
  }
}

export default {
  id: 'satellites',
  name: 'Satellites',
  intervalMs: MAX_AGE_MS,
  errorRetryMs: 30 * 60 * 1000, // CelesTrak blocks IPs that rack up errors; back off hard
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
    if (!results.length) throw new Error(errors.join('; '));

    const byId = new Map();
    for (const r of results) for (const s of parseTle(r.text, r.group)) if (!byId.has(s.id)) byId.set(s.id, s);
    const satellites = [...byId.values()];
    const oldest = Math.min(...results.map((r) => r.fetchedAt));
    const problems = [...errors, ...results.filter((r) => r.error).map((r) => `${r.group}: ${r.error}`)];
    return {
      data: { fetchedAt: oldest, satellites },
      count: satellites.length,
      updatedAt: oldest,
      note: `Element sets fetched ${new Date(oldest).toISOString().slice(11, 16)} UTC; positions are computed live in the browser.${problems.length ? ` Using cached data: ${problems.join('; ')}` : ''}`,
      nextDelayMs: Math.max(5 * 60_000, oldest + MAX_AGE_MS - Date.now() + 60_000),
    };
  },
};
