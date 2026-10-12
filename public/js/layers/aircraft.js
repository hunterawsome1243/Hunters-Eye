import { putJson } from '../api.js';
import { dateTime, el, latLon, nearLon, num, timeAgo } from '../ui/format.js';
import { legend } from '../ui/legend.js';

const COLOR = '#38bdf8';
const MAX_EXTRAPOLATE_S = 300;
const HIT_RADIUS = 10;
const EMERGENCY = { '7500': 'Hijack (7500)', '7600': 'Radio failure (7600)', '7700': 'General emergency (7700)' };
const CATEGORY = ['No info', 'No ADS-B category', 'Light', 'Small', 'Large', 'High-vortex large', 'Heavy', 'High performance',
  'Rotorcraft', 'Glider', 'Lighter than air', 'Parachutist', 'Ultralight', 'Reserved', 'UAV', 'Space vehicle',
  'Emergency vehicle', 'Service vehicle', 'Point obstacle', 'Cluster obstacle', 'Line obstacle'];

// Plane silhouette pointing north, centred on 0,0, about 14px long.
const PLANE = new Path2D('M0 -7 L1.3 -2.2 L7 1.2 L7 2.4 L1.2 0.9 L0.9 4.6 L2.6 6 L2.6 7 L0 6.2 L-2.6 7 L-2.6 6 L-0.9 4.6 L-1.2 0.9 L-7 2.4 L-7 1.2 L-1.3 -2.2 Z');

// Plane colour by altitude (metres), ground first; also the legend under the filter.
const GROUND_COLOR = '#6b7280';
const ALTITUDE_BANDS = [
  [0, GROUND_COLOR, 'on ground'],
  [3000, '#5eead4', 'below 3 km'],
  [7000, '#38bdf8', '3–7 km'],
  [10000, '#a5b4fc', '7–10 km'],
  [Infinity, '#e0f2fe', 'above 10 km'],
];
function altitudeColor(a) {
  if (a.onGround) return GROUND_COLOR;
  const alt = a.altitude ?? 0;
  return (ALTITUDE_BANDS.find(([max]) => max > 0 && alt < max) ?? ALTITUDE_BANDS.at(-1))[1];
}

// Thousands of aircraft as DOM markers would crawl, so they are painted on one
// canvas and redrawn on every move. The canvas lives in its own pane between the
// tiles and the vector overlays, so quakes, alerts and satellites stay on top.
// Clicks are hit-tested in create() below.
const CanvasLayer = L.Layer.extend({
  initialize(draw) {
    this._draw = draw;
  },
  onAdd(map) {
    if (!map.getPane('aircraft')) map.createPane('aircraft').style.zIndex = 350;
    this._canvas = L.DomUtil.create('canvas', 'aircraft-canvas', map.getPane('aircraft'));
    map.on('move resize zoomend viewreset', this.redraw, this);
    map.on('zoomstart', this._hide, this);
    this.redraw();
  },
  onRemove(map) {
    map.off('move resize zoomend viewreset', this.redraw, this);
    map.off('zoomstart', this._hide, this);
    this._canvas.remove();
    this._canvas = null;
  },
  _hide() {
    if (this._canvas) this._canvas.style.visibility = 'hidden';
  },
  redraw() {
    if (!this._canvas || this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      if (!this._canvas) return;
      const size = this._map.getSize();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(size.x * dpr);
      const h = Math.round(size.y * dpr);
      if (this._canvas.width !== w || this._canvas.height !== h) {
        this._canvas.width = w;
        this._canvas.height = h;
        this._canvas.style.width = `${size.x}px`;
        this._canvas.style.height = `${size.y}px`;
      }
      // The pane moves with the map while dragging; pin the canvas to the viewport.
      L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
      const g = this._canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size.x, size.y);
      this._draw(g, this._map, size);
      this._canvas.style.visibility = '';
    });
  },
});

export default function create(ctx) {
  const { map, feed, detail } = ctx;
  let aircraft = []; // objects built from the server's compact rows
  let byIcao = new Map();
  let selected = null;
  let onlyInView = false;
  let drawn = { xs: new Float32Array(0), ys: new Float32Array(0), idx: new Int32Array(0), n: 0 };
  let inViewCount = 0;

  const layer = new CanvasLayer(draw);

  // Estimated position now, from the last report plus speed along the heading.
  // Age is measured on the server's clock, so a skewed browser clock doesn't matter.
  function position(a, nowMs = Date.now()) {
    if (a.onGround || !a.velocity || a.track == null || a.timePosition == null) return [a.lat, a.lon];
    const age = (nowMs + ctx.clockOffset()) / 1000 - a.timePosition;
    const dt = Math.min(Math.max(age, 0), MAX_EXTRAPOLATE_S);
    const d = a.velocity * dt;
    const rad = (a.track * Math.PI) / 180;
    const lat = a.lat + (d * Math.cos(rad)) / 111_320;
    const lon = a.lon + (d * Math.sin(rad)) / (111_320 * Math.max(Math.cos((a.lat * Math.PI) / 180), 0.01));
    return [lat, lon];
  }

  function draw(g, m, size) {
    const n = aircraft.length;
    if (drawn.xs.length < n) drawn = { xs: new Float32Array(n), ys: new Float32Array(n), idx: new Int32Array(n), n: 0 };
    drawn.n = 0;
    const centerLon = m.getCenter().lng;
    const now = Date.now();
    const scale = m.getZoom() < 4 ? 0.75 : m.getZoom() < 7 ? 1 : 1.25;
    let sel = null;
    for (let i = 0; i < n; i++) {
      const a = aircraft[i];
      const [lat, lon0] = position(a, now);
      const lon = lon0 + 360 * Math.round((centerLon - lon0) / 360);
      const p = m.latLngToContainerPoint([lat, lon]);
      if (p.x < -10 || p.y < -10 || p.x > size.x + 10 || p.y > size.y + 10) continue;
      const k = drawn.n++;
      drawn.xs[k] = p.x;
      drawn.ys[k] = p.y;
      drawn.idx[k] = i;
      if (a.icao24 === selected) {
        sel = { a, p };
        continue;
      }
      g.setTransform(scale * devicePixelRatio, 0, 0, scale * devicePixelRatio, p.x * devicePixelRatio, p.y * devicePixelRatio);
      g.rotate(((a.track ?? 0) * Math.PI) / 180);
      g.fillStyle = altitudeColor(a);
      g.fill(PLANE);
    }
    if (sel) {
      const dpr = devicePixelRatio;
      g.setTransform(dpr, 0, 0, dpr, sel.p.x * dpr, sel.p.y * dpr);
      g.beginPath();
      g.arc(0, 0, 13, 0, Math.PI * 2);
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.stroke();
      g.scale(1.5, 1.5);
      g.rotate(((sel.a.track ?? 0) * Math.PI) / 180);
      g.fillStyle = '#fde047';
      g.fill(PLANE);
    }
    inViewCount = drawn.n;
  }

  function hitTest(containerPoint) {
    let best = -1;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    for (let k = 0; k < drawn.n; k++) {
      const dx = drawn.xs[k] - containerPoint.x;
      const dy = drawn.ys[k] - containerPoint.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = drawn.idx[k];
      }
    }
    return best >= 0 ? aircraft[best] : null;
  }

  // Plane clicks are resolved by app.js after point layers (quakes, satellites)
  // had their chance, and before broad shapes (weather polygons) via ctx.pick().
  const container = map.getContainer();
  let hoverFrame = null;
  container.addEventListener('mousemove', (e) => {
    if (hoverFrame || !map.hasLayer(layer)) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = null;
      container.classList.toggle('hit', !!hitTest(map.mouseEventToContainerPoint(e)));
    });
  });

  function showDetail(a) {
    const [lat, lon] = position(a);
    detail.show({
      key: `aircraft:${a.icao24}`,
      color: altitudeColor(a),
      kind: 'Aircraft',
      heading: a.callsign || a.icao24.toUpperCase(),
      fields: [
        ['Callsign', a.callsign || '—'],
        ['ICAO 24-bit', a.icao24.toUpperCase()],
        ['Registered in', a.country],
        ['Altitude', a.onGround ? 'On ground' : a.altitude != null ? `${num(a.altitude)} m` : '—', a.onGround || a.altitude == null ? null : `${num(a.altitude * 3.28084)} ft`],
        ['Ground speed', a.velocity != null ? `${num(a.velocity * 3.6)} km/h` : '—', a.velocity != null ? `${num(a.velocity * 1.94384)} kt` : null],
        ['Heading', a.track != null ? `${num(a.track)}°` : '—'],
        ['Vertical rate', a.verticalRate != null ? `${a.verticalRate > 0 ? '+' : ''}${num(a.verticalRate, 1)} m/s` : null],
        ['Squawk', a.squawk ? `${a.squawk}${EMERGENCY[a.squawk] ? ` · ${EMERGENCY[a.squawk]}` : ''}` : null],
        ['Category', a.category > 1 ? CATEGORY[a.category] : null],
        ['Position', latLon(lat, lon)],
        ['Last report', a.lastContact ? dateTime(a.lastContact * 1000) : '—', a.lastContact ? timeAgo(a.lastContact * 1000) : null],
      ],
      notes: a.onGround || !a.velocity ? '' : 'Position is estimated from the last report using speed and heading.',
      link: { href: `https://globe.adsbexchange.com/?icao=${a.icao24}`, label: 'Track on ADS-B Exchange ↗' },
      latlng: [lat, nearLon(lon, map.getCenter().lng)],
    });
  }

  function select(icao) {
    selected = icao;
    const a = byIcao.get(icao);
    if (!a) return;
    ctx.select(api);
    showDetail(a);
    layer.redraw();
  }

  function focus(icao) {
    const a = byIcao.get(icao);
    if (!a || !map.hasLayer(layer)) return;
    map.flyTo(position(a), Math.max(map.getZoom(), 7), { duration: 0.8 });
    select(icao);
  }

  function update(data) {
    const f = data.fields;
    aircraft = data.states.map((row) => Object.fromEntries(f.map((k, i) => [k, row[i]])));
    byIcao = new Map(aircraft.map((a) => [a.icao24, a]));
    for (const a of aircraft) {
      if (!EMERGENCY[a.squawk]) continue;
      feed.add({
        id: `aircraft:${a.icao24}:${a.squawk}`,
        source: 'aircraft',
        time: (a.lastContact ?? data.time / 1000) * 1000,
        color: '#f87171',
        title: `${a.callsign || a.icao24.toUpperCase()} squawking ${a.squawk}`,
        subtitle: `${EMERGENCY[a.squawk].replace(/ \(\d+\)/, '')} · ${a.country} · ${a.onGround ? 'on ground' : `${num(a.altitude)} m`}`,
        onClick: () => focus(a.icao24),
      });
    }
    if (selected && detail.key === `aircraft:${selected}`) {
      if (byIcao.has(selected)) showDetail(byIcao.get(selected));
    }
    layer.redraw();
  }

  // Animate estimated positions between refreshes.
  setInterval(() => {
    if (!map.hasLayer(layer) || !aircraft.length) return;
    layer.redraw();
    if (selected && detail.key === `aircraft:${selected}` && byIcao.has(selected)) showDetail(byIcao.get(selected));
  }, 2000);

  // Filter: only fetch and count aircraft in the current view.
  const hint = el('div', { class: 'hint' }, 'Covers the whole world.');
  const checkbox = el('input', { type: 'checkbox' });
  const filter = el('div', { class: 'filter' }, el('label', {}, 'Only aircraft in current view', checkbox), hint,
    legend(ALTITUDE_BANDS.map(([, c, label]) => [c, label]), { label: 'Aircraft altitude colors' }));
  ctx.addFilter(filter);

  function viewBox() {
    const b = map.getBounds();
    return { lamin: b.getSouth(), lomin: b.getWest(), lamax: b.getNorth(), lomax: b.getEast() };
  }
  let sendTimer = null;
  function sendView() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      putJson('/api/sources/aircraft/options', { bbox: onlyInView ? viewBox() : null }).catch((err) => console.warn('aircraft options:', err.message));
    }, 800);
  }
  checkbox.addEventListener('change', () => {
    onlyInView = checkbox.checked;
    sendView();
    ctx.feed.refresh();
  });
  map.on('moveend', () => {
    if (onlyInView) sendView();
  });
  // Tell the server our setting on load (a previous page may have left a box set),
  // then keep the box alive while the filter is on; the server drops stale ones.
  sendView();
  setInterval(() => {
    if (onlyInView) sendView();
  }, 4 * 60_000);

  const api = {
    id: 'aircraft',
    name: 'Aircraft',
    source: 'OpenSky Network',
    color: COLOR,
    layer,
    visible: true,
    update,
    pick(containerPoint) {
      const a = hitTest(containerPoint);
      if (a) select(a.icao24);
      return !!a;
    },
    onHide() {
      container.classList.remove('hit');
    },
    count: () => (onlyInView ? inViewCount : aircraft.length),
    fetchOptions: () => ({ bbox: onlyInView ? viewBox() : null }),
    onStatus(s) {
      const every = s.intervalMs >= 60_000 ? `${Math.round(s.intervalMs / 60_000)} min` : `${Math.round(s.intervalMs / 1000)} s`;
      hint.textContent = `${s.note ? `${s.note.split('.')[0]}.` : ''} Refreshes every ${every}${onlyInView ? '; a smaller view refreshes faster' : ''}.`.trim();
    },
    acceptsFeed(entry) {
      if (!onlyInView) return true;
      const a = byIcao.get(entry.id.split(':')[1]);
      return !!a && map.getBounds().pad(0.1).contains(position(a));
    },
    focusFirst() {
      const a = aircraft.find((x) => !x.onGround && x.velocity) || aircraft[0];
      if (a) focus(a.icao24);
      return !!a;
    },
    clearSelection() {
      if (selected === null) return;
      selected = null;
      layer.redraw();
    },
  };
  return api;
}
