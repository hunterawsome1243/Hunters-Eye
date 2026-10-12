import { intervalFromEnv } from '../lib/env.js';
import { HttpError, request } from '../lib/http.js';
import {
  ANONYMOUS_CREDITS,
  CLIENT_CREDITS,
  FIELDS,
  creditCost,
  delayFor as sharedDelayFor,
  normalizeBbox,
  normalizeStates,
  statesQuery,
} from '../../shared/opensky.js';

// OpenSky Network REST API, /states/all. The budgeting and parsing live in
// shared/opensky.js, which the browser fallback uses too.
const API = process.env.OPENSKY_URL || 'https://opensky-network.org/api';
const TOKEN_URL =
  process.env.OPENSKY_TOKEN_URL ||
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const CLIENT_ID = process.env.OPENSKY_CLIENT_ID?.trim();
const CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET?.trim();

export { FIELDS, creditCost, normalizeBbox, normalizeStates };

export function dailyCredits(authenticated = !!(CLIENT_ID && CLIENT_SECRET)) {
  return authenticated ? CLIENT_CREDITS : ANONYMOUS_CREDITS;
}

export function delayFor(bbox, credits = dailyCredits()) {
  return sharedDelayFor(bbox, credits);
}

let token = null; // { value, expiresAt }

async function getToken(force = false) {
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  if (!force && token && token.expiresAt > Date.now()) return token.value;
  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const json = await res.json();
  token = { value: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 1800) - 60) * 1000 };
  return token.value;
}

const overrideMs = intervalFromEnv('AIRCRAFT_INTERVAL_SEC', 0);
// The browser re-sends its view every few minutes while the filter is on. If it
// stops (tab closed, page reloaded), go back to the whole world.
const BBOX_TTL_MS = 10 * 60_000;
let bbox = null;
let bboxSetAt = 0;

function currentBbox() {
  if (bbox && Date.now() - bboxSetAt > BBOX_TTL_MS) bbox = null;
  return bbox;
}

async function fetchStates(box, retry = true) {
  const params = statesQuery(box);
  const auth = await getToken();
  try {
    return await request(`${API}/states/all?${params}`, {
      headers: auth ? { Authorization: `Bearer ${auth}` } : {},
      timeoutMs: 30_000,
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 401 && auth && retry) {
      await getToken(true);
      return fetchStates(box, false);
    }
    if (err instanceof HttpError && err.status === 429) err.message = 'OpenSky credit limit reached for today; waiting before retrying';
    throw err;
  }
}

export default {
  id: 'aircraft',
  name: 'Aircraft',
  intervalMs: () => overrideMs || delayFor(currentBbox()),
  errorRetryMs: 120_000,
  // If this server can't reach OpenSky, browsers fetch from here themselves
  // (public/js/fallback.js), anonymously: the API client secret never leaves the server.
  browserUrl: process.env.OPENSKY_BROWSER_URL || API,
  describe: () => `${CLIENT_ID ? 'OpenSky API client' : 'anonymous OpenSky'}, ${dailyCredits()} credits/day`,
  setOptions(opts) {
    bbox = normalizeBbox(opts.bbox);
    bboxSetAt = Date.now();
  },
  async fetch() {
    const box = currentBbox();
    const res = await fetchStates(box);
    const data = { ...normalizeStates(await res.json()), bbox: box };
    const remaining = res.headers.get('x-rate-limit-remaining');
    const scope = box ? 'map view' : 'whole world';
    return {
      data,
      count: data.states.length,
      note: `Covers the ${scope}. ${remaining != null ? `${remaining} OpenSky credits left today. ` : ''}${CLIENT_ID ? '' : 'Add an OpenSky API client in .env for faster refresh.'}`.trim(),
      nextDelayMs: overrideMs || delayFor(box),
    };
  },
};
