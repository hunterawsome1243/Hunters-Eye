import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

// group -> { text, downloadedAt }. Mirrors the disk cache and stands in for it
// when CACHE_DIR is empty or not writable.
const memory = new Map();
// group -> when we last asked CelesTrak and got no new data (or an error).
const checkedAt = new Map();

const cacheFile = (group) => join(CACHE_DIR, `celestrak-${group.toLowerCase()}.tle`);

function readCache(group) {
  if (memory.has(group) || !CACHE_DIR) return memory.get(group) ?? null;
  try {
    const entry = { text: readFileSync(cacheFile(group), 'utf8'), downloadedAt: statSync(cacheFile(group)).mtimeMs };
    memory.set(group, entry);
    return entry;
  } catch {
    return null;
  }
}

function writeCache(group, text) {
  memory.set(group, { text, downloadedAt: Date.now() });
  if (!CACHE_DIR) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cacheFile(group), text);
  } catch (err) {
    console.warn(`[satellites] could not write cache: ${err.message}`);
  }
}

export const __testing = { memory, checkedAt };

const lastAsked = (group, cached) => Math.max(cached?.downloadedAt ?? 0, checkedAt.get(group) ?? 0);

async function loadGroup(group) {
  const cached = readCache(group);
  if (cached && Date.now() - lastAsked(group, cached) < MAX_AGE_MS) return cached;
  let text;
  try {
    text = await getText(`${BASE}?GROUP=${group}&FORMAT=TLE`, { timeoutMs: 30_000 });
    if (!parseTle(text, group).length) throw new Error(`CelesTrak returned no element sets for ${group}`);
  } catch (err) {
    // A 403 usually means "no newer data since your last download"; other errors
    // count against CelesTrak's firewall threshold. Either way, don't ask again
    // until the next 2-hour update, and keep using what we have.
    checkedAt.set(group, Date.now());
    if (!cached) throw err;
    return { ...cached, error: err instanceof HttpError && err.status === 403 ? null : err.message };
  }
  writeCache(group, text);
  return memory.get(group);
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
    // Report when the elements were really downloaded, so old data shows as stale.
    const oldest = Math.min(...results.map((r) => r.downloadedAt));
    const ageH = (Date.now() - oldest) / 3_600_000;
    const problems = [...errors, ...results.filter((r) => r.error).map((r) => `${r.group}: ${r.error}`)];
    const notes = [`Element sets downloaded ${new Date(oldest).toISOString().slice(0, 16).replace('T', ' ')} UTC; positions are computed live in the browser.`];
    if (ageH > 24) notes.push(`Elements are ${Math.round(ageH)} hours old, so positions are less accurate.`);
    if (problems.length) notes.push(`Using cached data: ${problems.join('; ')}`);
    const nextCheck = Math.min(...GROUPS.map((g) => lastAsked(g, memory.get(g)) + MAX_AGE_MS));
    return {
      data: { fetchedAt: oldest, satellites },
      count: satellites.length,
      updatedAt: oldest,
      note: notes.join(' '),
      nextDelayMs: Math.max(5 * 60_000, nextCheck - Date.now() + 60_000),
    };
  },
};
