// OpenSky helpers used by both the server (server/sources/aircraft.js) and the
// browser fallback (public/js/fallback.js). No Node or DOM APIs in here.
// Docs: https://openskynetwork.github.io/opensky-api/rest.html
//
// Anonymous use gets 400 credits a day; a free account's API client gets 4000.
// A request costs 1-4 credits depending on the bounding box area, so we wait
// cost x (24h / daily credits) after each request, plus a safety margin. That
// keeps a client running all day inside the budget whatever the box.
export const ANONYMOUS_CREDITS = 400;
export const CLIENT_CREDITS = 4000;
const DAY_MS = 86_400_000;
const SAFETY = 1.15;
const MIN_DELAY_MS = 10_000; // OpenSky's own time resolution for anonymous users

export const FIELDS = ['icao24', 'callsign', 'country', 'lon', 'lat', 'altitude', 'onGround', 'velocity', 'track', 'verticalRate', 'squawk', 'timePosition', 'lastContact', 'category', 'geoAltitude'];

export function creditCost(bbox) {
  if (!bbox) return 4;
  const area = (bbox.lamax - bbox.lamin) * (bbox.lomax - bbox.lomin);
  if (area <= 25) return 1;
  if (area <= 100) return 2;
  if (area <= 400) return 3;
  return 4;
}

export function delayFor(bbox, credits) {
  return Math.max(MIN_DELAY_MS, Math.ceil(((creditCost(bbox) * DAY_MS) / credits) * SAFETY));
}

const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const round2 = (n) => Math.round(n * 100) / 100;
const round5 = (n) => Math.round(n * 1e5) / 1e5;

// Turn the browser's map bounds into a box OpenSky accepts. Pads it so small pans
// stay covered, and falls back to the whole world (null) for views that cross the
// antimeridian or are so large a box saves no credits.
export function normalizeBbox(input) {
  if (!input) return null;
  const vals = ['lamin', 'lomin', 'lamax', 'lomax'].map((k) => Number(input[k]));
  if (vals.some((v) => !Number.isFinite(v))) throw new Error('bbox needs numeric lamin, lomin, lamax, lomax');
  let [lamin, lomin, lamax, lomax] = vals;
  if (lamax <= lamin || lomax <= lomin) throw new Error('bbox is empty');
  const padLat = (lamax - lamin) * 0.15;
  const padLon = (lomax - lomin) * 0.15;
  lamin = Math.max(-90, lamin - padLat);
  lamax = Math.min(90, lamax + padLat);
  lomin -= padLon;
  lomax += padLon;
  if (lomax - lomin >= 360) return null;
  const shift = wrap(lomin) - lomin;
  lomin += shift;
  lomax += shift;
  if (lomax > 180) return null;
  const bbox = { lamin: round2(lamin), lomin: round2(lomin), lamax: round2(lamax), lomax: round2(lomax) };
  return creditCost(bbox) === 4 ? null : bbox;
}

export function statesQuery(bbox) {
  const params = new URLSearchParams({ extended: '1' });
  if (bbox) for (const [k, v] of Object.entries(bbox)) params.set(k, v);
  return params;
}

// Compact rows in FIELDS order; drops aircraft without a position.
export function normalizeStates(json) {
  const states = (json.states || [])
    .filter((s) => s[5] != null && s[6] != null)
    .map((s) => [
      s[0],
      (s[1] || '').trim(),
      s[2],
      round5(s[5]),
      round5(s[6]),
      s[7] ?? s[13] ?? null,
      !!s[8],
      s[9],
      s[10],
      s[11],
      s[14] || null,
      s[3] ?? s[4],
      s[4],
      s[17] ?? null,
      s[13] ?? null,
    ]);
  return { time: (json.time ?? Math.floor(Date.now() / 1000)) * 1000, fields: FIELDS, states };
}
