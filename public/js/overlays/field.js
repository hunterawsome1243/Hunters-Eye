// The maths behind the overlays, with no DOM: the colour ramps, sampling the
// weather grid between its points, the mercator image the heat map is painted
// into, and where the Sun is for the night side. test/overlays.test.js runs
// this file under Node.
import { geodesicCircle } from '../globe/geo.js';

// Colour ramps as [value, [r, g, b, a]] stops. They sit over dark satellite
// imagery at 60%, so every ramp reads from dim to bright: the quiet end of each
// scale nearly disappears into the planet and only what matters lights up.
export const RAMPS = {
  temperature: {
    unit: '°C', min: -30, max: 42,
    stops: [[-30, [120, 100, 220, 200]], [-15, [60, 110, 230, 210]], [0, [60, 190, 230, 220]], [10, [90, 215, 160, 220]], [20, [240, 220, 90, 225]], [28, [250, 150, 60, 230]], [36, [235, 70, 50, 240]], [42, [190, 20, 70, 245]]],
  },
  wind: {
    unit: 'km/h', min: 0, max: 90,
    stops: [[0, [34, 211, 238, 0]], [12, [34, 211, 238, 70]], [30, [56, 189, 248, 170]], [55, [167, 139, 250, 220]], [90, [244, 114, 182, 240]]],
  },
  rain: {
    unit: 'mm/h', min: 0, max: 8,
    stops: [[0, [96, 165, 250, 0]], [0.2, [96, 165, 250, 90]], [1.5, [59, 130, 246, 180]], [4, [129, 140, 248, 220]], [8, [232, 121, 249, 240]]],
  },
  clouds: {
    unit: '%', min: 0, max: 100,
    stops: [[0, [226, 232, 240, 0]], [35, [226, 232, 240, 40]], [70, [226, 232, 240, 140]], [100, [248, 250, 252, 220]]],
  },
};

// The ramp's colour at a value, blended between the two stops around it.
export function colorAt(ramp, v) {
  const { stops } = ramp;
  if (v == null || Number.isNaN(v)) return [0, 0, 0, 0];
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i];
    if (v <= v1) {
      const [v0, c0] = stops[i - 1];
      const t = (v - v0) / (v1 - v0);
      return c0.map((a, k) => Math.round(a + (c1[k] - a) * t));
    }
  }
  return stops[stops.length - 1][1];
}

// CSS for the legend bar: the ramp as a horizontal gradient.
export function rampCss(ramp) {
  const span = ramp.max - ramp.min;
  return `linear-gradient(90deg, ${ramp.stops.map(([v, [r, g, b, a]]) => `rgba(${r},${g},${b},${Math.max(a, 60) / 255}) ${(((v - ramp.min) / span) * 100).toFixed(1)}%`).join(', ')})`;
}

// The grid's value at any point, from the four points around it (longitude wraps,
// latitude is held at the grid's edge rows so the poles take the nearest value).
// Missing points (null) drop out of the blend.
export function sample(grid, values, lat, lon) {
  const { lat0, lon0, step, rows, cols } = grid;
  const fr = Math.min(Math.max((lat - lat0) / step, 0), rows - 1);
  const fc = (((lon - lon0) / step) % cols + cols) % cols;
  const r0 = Math.floor(fr);
  const r1 = Math.min(r0 + 1, rows - 1);
  const c0 = Math.floor(fc);
  const c1 = (c0 + 1) % cols;
  const tr = fr - r0;
  const tc = fc - c0;
  let sum = 0;
  let weight = 0;
  for (const [r, c, w] of [[r0, c0, (1 - tr) * (1 - tc)], [r0, c1, (1 - tr) * tc], [r1, c0, tr * (1 - tc)], [r1, c1, tr * tc]]) {
    const v = values[r * cols + c];
    if (v == null || !w) continue;
    sum += v * w;
    weight += w;
  }
  return weight ? sum / weight : null;
}

// Web Mercator, the projection the image source is stretched in.
export const MERCATOR_LAT = 85.0511;
const toY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
export function latOfRow(row, height) {
  const yTop = toY(MERCATOR_LAT);
  const y = yTop - ((row + 0.5) / height) * 2 * yTop;
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}
// Corners for the image source: top-left, top-right, bottom-right, bottom-left.
export const IMAGE_CORNERS = [[-180, MERCATOR_LAT], [180, MERCATOR_LAT], [180, -MERCATOR_LAT], [-180, -MERCATOR_LAT]];

// RGBA pixels (width x height, row 0 at the top) of a field painted through its ramp.
export function paintField(grid, values, ramp, width, height, out = new Uint8ClampedArray(width * height * 4)) {
  for (let row = 0; row < height; row++) {
    const lat = latOfRow(row, height);
    for (let col = 0; col < width; col++) {
      const lon = -180 + ((col + 0.5) / width) * 360;
      const [r, g, b, a] = colorAt(ramp, sample(grid, values, lat, lon));
      const i = (row * width + col) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  }
  return out;
}

// Where the Sun is overhead (declination and equation of time, good to ~0.1°).
export function subsolarPoint(date = new Date()) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86_400_000; // days since J2000
  const rad = Math.PI / 180;
  const g = ((357.529 + 0.98560028 * d) % 360) * rad; // mean anomaly
  const q = (280.459 + 0.98564736 * d) % 360; // mean longitude
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad; // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * rad; // obliquity
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)); // right ascension
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const eqt = (q * rad - ra); // equation of time, radians of a day
  const utcHours = (date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600);
  let lon = -(utcHours - 12) * 15 - (eqt / rad); // where local solar noon is now
  lon = ((lon + 540) % 360) - 180;
  return { lat: dec / rad, lon };
}

// The half of the planet in darkness, as a GeoJSON polygon around the point
// opposite the Sun. The ring reaches the dark pole and is fillable as it is.
const EARTH_RADIUS_KM = 6371;
export function nightPolygon(date = new Date()) {
  const sun = subsolarPoint(date);
  const lat = -sun.lat;
  const lon = ((sun.lon + 360) % 360) - 180;
  const ring = geodesicCircle(lon, lat, (Math.PI / 2) * EARTH_RADIUS_KM, 180);
  return { type: 'Feature', properties: { sun }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

// Readable units: °F, mph and inches where the browser is American.
export function localUnits(locale = 'en-US') {
  return /^en-(US|LR|MM)$/i.test(locale) ? 'us' : 'metric';
}
export function convert(field, v, units) {
  if (v == null) return null;
  if (units !== 'us') return v;
  if (field === 'temperature') return v * 1.8 + 32;
  if (field === 'wind') return v / 1.609344;
  if (field === 'rain') return v / 25.4;
  return v;
}
export function unitLabel(field, units) {
  if (units !== 'us') return RAMPS[field].unit;
  return { temperature: '°F', wind: 'mph', rain: 'in/h', clouds: '%' }[field];
}

// The grid point nearest a place, for a value that cannot be blended between
// points, such as a wind direction across 360°.
export function nearestIndex(grid, lat, lon) {
  const { lat0, lon0, step, rows, cols } = grid;
  const r = Math.min(Math.max(Math.round((lat - lat0) / step), 0), rows - 1);
  const c = ((Math.round((lon - lon0) / step) % cols) + cols) % cols;
  return r * cols + c;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg) {
  if (deg == null || !Number.isFinite(deg)) return '';
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// A value as the readout prints it, in the reader's units, without the unit.
export function formatValue(field, v, units) {
  const c = convert(field, v, units);
  if (c == null) return '';
  if (field === 'rain') return c.toFixed(units === 'us' ? 2 : 1);
  return Math.round(c).toString();
}

// The weather at a place, read off the grid: each field blended between the four
// points round it, the wind direction from the nearest point. Null where the grid
// has nothing yet (the poles before their wave has arrived).
export function probe(data, lat, lon) {
  const { grid, fields } = data;
  const out = {};
  for (const f of ['temperature', 'wind', 'rain', 'clouds']) out[f] = sample(grid, fields[f] ?? [], lat, lon);
  out.windDir = fields.windDir?.[nearestIndex(grid, lat, lon)] ?? null;
  return Object.values(out).some((v) => v != null) ? out : null;
}
