import { dateTime, el, latLon, nearLon, num, timeAgo } from '../ui/format.js';

const COLOR = '#e879f9';
const EARTH_RADIUS_KM = 6371;
const TICK_MS = 1000;
const TRACK_STEP_S = 30;
const DEFAULT_TRACKED = '25544'; // ISS

// Sub-satellite point, altitude and speed at a given time, or null if SGP4 fails
// (for example an object whose elements are too old to propagate).
export function locate(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv?.position || !pv.velocity) return null;
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
  const { x, y, z } = pv.velocity;
  return {
    lat: satellite.degreesLat(geo.latitude),
    lon: satellite.degreesLong(geo.longitude),
    alt: geo.height,
    speed: Math.sqrt(x * x + y * y + z * z),
  };
}

// Points along the ground track, split wherever it crosses the antimeridian.
function trackSegments(satrec, fromMs, toMs) {
  const segments = [[]];
  let prevLon = null;
  for (let t = fromMs; t <= toMs; t += TRACK_STEP_S * 1000) {
    const p = locate(satrec, new Date(t));
    if (!p) continue;
    if (prevLon !== null && Math.abs(p.lon - prevLon) > 180) segments.push([]);
    segments[segments.length - 1].push([p.lat, p.lon]);
    prevLon = p.lon;
  }
  return segments.filter((s) => s.length > 1);
}

function epochDate(satrec) {
  const year = satrec.epochyr < 57 ? 2000 + satrec.epochyr : 1900 + satrec.epochyr;
  return Date.UTC(year, 0, 1) + (satrec.epochdays - 1) * 86_400_000;
}

export default function create(ctx) {
  const { map, feed, detail } = ctx;
  const group = L.featureGroup();
  const trackLayer = L.layerGroup().addTo(group);
  const sats = new Map(); // id -> { sat, satrec, marker, pos }
  let selected = null;
  let tracked = DEFAULT_TRACKED;
  let notableOnly = false;
  let trackDrawnAt = 0;

  const filterBox = el('input', { type: 'checkbox' });
  ctx.addFilter(el('div', { class: 'filter' },
    el('label', {}, 'Only notable satellites', filterBox),
    el('div', { class: 'hint' }, 'Labelled: ISS, Tiangong, Hubble and a few others. The ground track follows the selected satellite (ISS by default).')));
  filterBox.addEventListener('change', () => {
    notableOnly = filterBox.checked;
    for (const s of sats.values()) applyVisibility(s);
  });

  function applyVisibility(s) {
    const show = !notableOnly || s.sat.notable || s.sat.id === selected;
    if (show && s.pos && !group.hasLayer(s.marker)) group.addLayer(s.marker);
    else if ((!show || !s.pos) && group.hasLayer(s.marker)) group.removeLayer(s.marker);
  }

  function markerStyle(s) {
    const isSel = s.sat.id === selected;
    return {
      radius: s.sat.notable ? 6 : 3.5,
      color: isSel ? '#ffffff' : COLOR,
      weight: isSel ? 2.5 : 1,
      fillColor: COLOR,
      fillOpacity: s.sat.notable ? 0.9 : 0.6,
    };
  }

  function drawTrack() {
    trackLayer.clearLayers();
    const s = sats.get(tracked);
    trackDrawnAt = Date.now();
    if (!s?.pos) return;
    const periodMs = ((2 * Math.PI) / s.satrec.no) * 60_000;
    const now = Date.now();
    const center = map.getCenter().lng;
    // Each segment lies within [-180, 180]; move it to the world copy in view.
    const shift = (seg) => {
      const d = nearLon(seg[Math.floor(seg.length / 2)][1], center) - seg[Math.floor(seg.length / 2)][1];
      return d ? seg.map(([lat, lon]) => [lat, lon + d]) : seg;
    };
    for (const seg of trackSegments(s.satrec, now - periodMs / 2, now)) {
      L.polyline(shift(seg), { color: COLOR, weight: 1.5, opacity: 0.45, dashArray: '4 6', interactive: false }).addTo(trackLayer);
    }
    for (const seg of trackSegments(s.satrec, now, now + periodMs)) {
      L.polyline(shift(seg), { color: COLOR, weight: 2, opacity: 0.85, interactive: false }).addTo(trackLayer);
    }
    s.footprint = L.circle([s.pos.lat, nearLon(s.pos.lon, center)], {
      radius: footprintRadius(s.pos.alt), color: COLOR, weight: 1, opacity: 0.5, fillOpacity: 0.06, interactive: false,
    }).addTo(trackLayer);
  }

  // Ground radius from which the satellite is above the horizon.
  const footprintRadius = (altKm) => EARTH_RADIUS_KM * Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altKm)) * 1000;

  function showDetail(s) {
    const { sat, satrec, pos } = s;
    const periodMin = (2 * Math.PI) / satrec.no;
    const epoch = epochDate(satrec);
    detail.show({
      key: `satellites:${sat.id}`,
      color: COLOR,
      kind: 'Satellite',
      heading: sat.notable && !sat.name.includes(sat.notable) ? `${sat.notable} · ${sat.name}` : sat.name,
      fields: [
        ['NORAD ID', sat.id],
        ['Altitude', pos ? `${num(pos.alt)} km` : '—'],
        ['Speed', pos ? `${num(pos.speed, 2)} km/s (${num(pos.speed * 3600)} km/h)` : '—'],
        ['Position', pos ? latLon(pos.lat, pos.lon) : '—'],
        ['Inclination', `${num((satrec.inclo * 180) / Math.PI, 2)}°`],
        ['Orbital period', `${num(periodMin, 1)} min`],
        ['Element set epoch', `${dateTime(epoch)} (${timeAgo(epoch)})`],
        ['CelesTrak group', sat.group.toLowerCase()],
      ],
      notes: 'Dashed line: last half orbit. Solid line: next full orbit. Circle: area from which it is above the horizon.',
      link: { href: `https://www.n2yo.com/satellite/?s=${encodeURIComponent(sat.id)}`, label: 'Pass predictions on N2YO ↗' },
      latlng: pos ? [pos.lat, nearLon(pos.lon, map.getCenter().lng)] : null,
    });
  }

  function select(id) {
    const s = sats.get(id);
    if (!s) return;
    const prev = sats.get(selected);
    selected = id;
    tracked = id;
    ctx.select(api);
    if (prev) prev.marker.setStyle(markerStyle(prev));
    s.marker.setStyle(markerStyle(s)).bringToFront();
    applyVisibility(s);
    drawTrack();
    showDetail(s);
  }

  function focus(id) {
    const s = sats.get(id);
    if (!s?.pos || !map.hasLayer(group)) return;
    map.flyTo([s.pos.lat, nearLon(s.pos.lon, map.getCenter().lng)], Math.max(Math.min(map.getZoom(), 4), 3), { duration: 0.8 });
    select(id);
  }

  function tick() {
    const now = new Date();
    const center = map.getCenter().lng;
    for (const s of sats.values()) {
      s.pos = locate(s.satrec, now);
      if (s.pos) s.marker.setLatLng([s.pos.lat, nearLon(s.pos.lon, center)]);
      applyVisibility(s);
    }
    const t = sats.get(tracked);
    if (t?.footprint && t.pos) t.footprint.setLatLng([t.pos.lat, nearLon(t.pos.lon, center)]).setRadius(footprintRadius(t.pos.alt));
    if (Date.now() - trackDrawnAt > 60_000) drawTrack();
    if (selected && sats.has(selected) && detail.key === `satellites:${selected}`) showDetail(sats.get(selected));
  }

  function update({ satellites, fetchedAt }) {
    const ids = new Set(satellites.map((s) => s.id));
    for (const [id, s] of sats) {
      if (ids.has(id)) continue;
      group.removeLayer(s.marker);
      sats.delete(id);
      if (id === selected) {
        selected = null;
        if (detail.key === `satellites:${id}`) detail.hide();
      }
      if (id === tracked) tracked = DEFAULT_TRACKED;
    }
    for (const sat of satellites) {
      const satrec = satellite.twoline2satrec(sat.line1, sat.line2);
      if (satrec.error) continue;
      const existing = sats.get(sat.id);
      if (existing) {
        Object.assign(existing, { sat, satrec });
        continue;
      }
      const s = { sat, satrec, pos: null, marker: L.circleMarker([0, 0], { bubblingMouseEvents: false }) };
      s.marker.setStyle(markerStyle(s));
      s.marker.on('click', () => select(sat.id));
      if (sat.notable) {
        s.marker.bindTooltip(sat.notable, { permanent: true, direction: 'right', offset: [8, 0], className: 'sat-label' });
      }
      sats.set(sat.id, s);
    }
    tick();
    drawTrack();
    feed.add({
      id: `satellites:elements:${fetchedAt}`,
      source: 'satellites',
      time: fetchedAt,
      color: COLOR,
      title: `Orbital elements for ${sats.size} satellites`,
      subtitle: 'CelesTrak: space stations and the brightest objects. Click to find the ISS.',
      onClick: () => focus(DEFAULT_TRACKED),
    });
  }

  setInterval(() => {
    if (map.hasLayer(group) && sats.size) tick();
  }, TICK_MS);
  map.on('moveend', () => {
    if (!map.hasLayer(group) || !sats.size) return;
    tick();
    drawTrack();
  });

  const api = {
    id: 'satellites',
    name: 'Satellites',
    source: 'CelesTrak',
    color: COLOR,
    layer: group,
    visible: true,
    update,
    count: () => [...sats.values()].filter((s) => s.pos && (!notableOnly || s.sat.notable)).length,
    focusFirst() {
      const id = sats.has(DEFAULT_TRACKED) ? DEFAULT_TRACKED : sats.keys().next().value;
      if (id) focus(id);
      return !!id;
    },
    clearSelection() {
      if (selected === null) return;
      const prev = sats.get(selected);
      selected = null;
      if (prev) {
        prev.marker.setStyle(markerStyle(prev));
        applyVisibility(prev);
      }
      tracked = DEFAULT_TRACKED;
      drawTrack();
    },
  };
  return api;
}
