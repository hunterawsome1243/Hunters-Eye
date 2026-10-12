import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { intervalFromEnv } from '../lib/env.js';
import { polygonsOf } from '../lib/geometry.js';
import { getJson } from '../lib/http.js';

// US National Weather Service active alerts. Free, no key, but a User-Agent is
// required. Rate limits are not published ("generous"); errors clear within ~5 s.
// Docs: https://www.weather.gov/documentation/services-web-api
// Warnings issued as storm polygons carry their own geometry. Zone- and county-
// based alerts have geometry: null, and the NWS geolocation guide says to fetch
// each zone's outline from /zones/{type}/{id}. Zone outlines barely change, so
// they are cached on disk and each one is only ever downloaded once.
const ALERTS_URL = process.env.NWS_URL || 'https://api.weather.gov/alerts/active?status=actual';
const API_ORIGIN = 'https://api.weather.gov';
const ZONE_ORIGIN = process.env.NWS_ZONE_BASE || API_ORIGIN; // tests point this at a fake
const CACHE_DIR = process.env.CACHE_DIR ?? fileURLToPath(new URL('../../data/cache', import.meta.url));
const ZONE_FILE = CACHE_DIR ? join(CACHE_DIR, 'nws-zones.json') : null;
const ZONES_PER_CYCLE = 300;
const ZONE_CONCURRENCY = 4;
const ZONE_RETRY_MS = 6 * 60 * 60 * 1000;
const ACCEPT = { Accept: 'application/geo+json' };

export const SEVERITY_ORDER = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];

// url -> { polygons } | { failedAt }
const zones = new Map();
if (ZONE_FILE) {
  try {
    for (const [url, polygons] of Object.entries(JSON.parse(readFileSync(ZONE_FILE, 'utf8')))) zones.set(url, { polygons });
  } catch {
    /* no cache yet */
  }
}

function saveZones() {
  if (!ZONE_FILE) return;
  const out = {};
  for (const [url, z] of zones) if (z.polygons) out[url] = z.polygons;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(ZONE_FILE, JSON.stringify(out));
}

const zoneUrl = (url) => (url.startsWith(API_ORIGIN) ? ZONE_ORIGIN + url.slice(API_ORIGIN.length) : url);

async function loadZones(urls) {
  const queue = [...urls];
  let loaded = 0;
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      try {
        const zone = await getJson(zoneUrl(url), { headers: ACCEPT, timeoutMs: 15_000 });
        zones.set(url, { polygons: polygonsOf(zone.geometry) });
        loaded++;
      } catch {
        zones.set(url, { failedAt: Date.now() });
      }
    }
  }
  await Promise.all(Array.from({ length: ZONE_CONCURRENCY }, worker));
  if (loaded) saveZones();
  return loaded;
}

const trim = (s, n) => (s && s.length > n ? `${s.slice(0, n).trimEnd()}…` : s || null);

export function normalizeAlert(f) {
  const p = f.properties || {};
  return {
    id: p.id || f.id,
    event: p.event,
    headline: p.headline,
    severity: SEVERITY_ORDER.includes(p.severity) ? p.severity : 'Unknown',
    certainty: p.certainty,
    urgency: p.urgency,
    areaDesc: p.areaDesc,
    sent: Date.parse(p.sent) || null,
    effective: Date.parse(p.effective) || null,
    expires: Date.parse(p.ends || p.expires) || null,
    sender: p.senderName,
    description: trim(p.description, 1500),
    instruction: trim(p.instruction, 800),
    zones: p.affectedZones || [],
    ownPolygons: polygonsOf(f.geometry),
  };
}

export default {
  id: 'weather',
  name: 'Severe weather',
  intervalMs: intervalFromEnv('WEATHER_INTERVAL_SEC', 120_000),
  errorRetryMs: 60_000,
  async fetch() {
    const json = await getJson(ALERTS_URL, { headers: ACCEPT, timeoutMs: 30_000 });
    const alerts = (json.features || []).map(normalizeAlert);

    // Outlines still needed, most severe alerts first.
    const now = Date.now();
    const wanted = [];
    const seen = new Set();
    const bySeverity = [...alerts].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    for (const a of bySeverity) {
      if (a.ownPolygons.length) continue;
      for (const url of a.zones) {
        const z = zones.get(url);
        if (seen.has(url) || z?.polygons || (z?.failedAt && now - z.failedAt < ZONE_RETRY_MS)) continue;
        seen.add(url);
        wanted.push(url);
      }
    }
    await loadZones(wanted.slice(0, ZONES_PER_CYCLE));
    const pending = Math.max(0, wanted.length - ZONES_PER_CYCLE);

    // Many alerts share zones (a heat advisory and a red flag warning over the same
    // counties), so outlines are sent once, keyed by zone, and alerts refer to them.
    let unmapped = 0;
    const zoneOut = {};
    const out = alerts.map(({ zones: urls, ownPolygons, ...a }) => {
      const zoneIds = [];
      for (const u of ownPolygons.length ? [] : urls) {
        const polygons = zones.get(u)?.polygons;
        if (!polygons?.length) continue;
        const id = u.split('/').slice(-2).join('/');
        zoneOut[id] = polygons;
        zoneIds.push(id);
      }
      if (!ownPolygons.length && !zoneIds.length) unmapped++;
      return { ...a, polygons: ownPolygons, zoneIds };
    });

    const notes = [];
    if (pending) notes.push(`Loading outlines for ${pending} more zones next refresh.`);
    if (unmapped) notes.push(`${unmapped} alerts have no outline to draw yet; they are still in the feed.`);
    return {
      data: { updated: Date.parse(json.updated) || now, alerts: out, zones: zoneOut },
      count: out.length,
      note: notes.join(' ') || null,
      nextDelayMs: pending ? 30_000 : undefined,
    };
  },
};
