// CelesTrak helpers used by both the server (server/sources/satellites.js) and the
// browser fallback (public/js/fallback.js). No Node or DOM APIs in here.
// Docs: https://celestrak.org/NORAD/documentation/gp-data-formats.php
// CelesTrak updates GP data about every 2 hours and, since March 2026, answers a
// repeat download before the next update with HTTP 403.
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;

// Space stations (ISS, Tiangong and visiting craft) plus the ~150 brightest objects.
export const GROUPS = ['STATIONS', 'VISUAL'];

export const NOTABLE = {
  25544: 'ISS',
  48274: 'Tiangong',
  20580: 'Hubble',
  27386: 'Envisat',
  33591: 'NOAA 19',
};

export const groupUrl = (base, group) => `${base}?GROUP=${group}&FORMAT=TLE`;

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

// [{ group, text }] -> satellites, each listed once (a station can be in both groups).
export function mergeGroups(results) {
  const byId = new Map();
  for (const r of results) for (const s of parseTle(r.text, r.group)) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()];
}
