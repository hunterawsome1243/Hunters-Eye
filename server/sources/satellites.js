import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, getText } from '../lib/http.js';
import { GROUPS, MAX_AGE_MS, NOTABLE, groupUrl, mergeGroups, parseTle } from '../../shared/celestrak.js';

// CelesTrak GP element sets (TLE format). The browser propagates positions itself
// with satellite.js, so the server only needs fresh elements now and then.
// CelesTrak answers a repeat download before its next 2-hourly update with HTTP 403,
// so each group is cached on disk and re-downloaded only when it is over 2 hours
// old, also across restarts. Parsing lives in shared/celestrak.js, which the
// browser fallback uses too.
const BASE = process.env.CELESTRAK_URL || 'https://celestrak.org/NORAD/elements/gp.php';
const CACHE_DIR = process.env.CACHE_DIR ?? fileURLToPath(new URL('../../data/cache', import.meta.url));

export { GROUPS, NOTABLE, parseTle };

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
    text = await getText(groupUrl(BASE, group), { timeoutMs: 30_000 });
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
  // If this server can't reach CelesTrak, browsers fetch from here themselves (public/js/fallback.js).
  browserUrl: process.env.CELESTRAK_BROWSER_URL || BASE,
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

    const satellites = mergeGroups(results);
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
