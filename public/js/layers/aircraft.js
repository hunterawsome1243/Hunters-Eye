import { putJson } from '../api.js';
import { dateTime, el, latLon, num, timeAgo } from '../ui/format.js';

const COLOR = '#38bdf8';
const MAX_EXTRAPOLATE_S = 300;
const HIT_RADIUS = 10;
const EMERGENCY = { '7500': 'Hijack (7500)', '7600': 'Radio failure (7600)', '7700': 'General emergency (7700)' };
const CATEGORY = ['No info', 'No ADS-B category', 'Light', 'Small', 'Large', 'High-vortex large', 'Heavy', 'High performance',
  'Rotorcraft', 'Glider', 'Lighter than air', 'Parachutist', 'Ultralight', 'Reserved', 'UAV', 'Space vehicle',
  'Emergency vehicle', 'Service vehicle', 'Point obstacle', 'Cluster obstacle', 'Line obstacle'];

// Plane silhouette pointing north, centred on 0,0, about 14px long.
const PLANE = new Path2D('M0 -7 L1.3 -2.2 L7 1.2 L7 2.4 L1.2 0.9 L0.9 4.6 L2.6 6 L2.6 7 L0 6.2 L-2.6 7 L-2.6 6 L-0.9 4.6 L-1.2 0.9 L-7 2.4 L-7 1.2 L-1.3 -2.2 Z');

function altitudeColor(a) {
  if (a.onGround) return '#6b7280';
  const alt = a.altitude ?? 0;
  if (alt < 3000) return '#5eead4';
  if (alt < 7000) return '#38bdf8';
  if (alt < 10000) return '#a5b4fc';
  return '#e0f2fe';
}

// Thousands of aircraft as DOM markers would crawl, so they are painted on one
// canvas laid over the map and redrawn on every move. Clicks are hit-tested here.
const CanvasLayer = L.Layer.extend({
  initialize(draw) {
    this._draw = draw;
  },
  onAdd(map) {
    this._canvas = L.DomUtil.create('canvas', 'aircraft-canvas', map.getContainer());
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
      if (this._canvas.width !== size.x * dpr || this._canvas.height !== size.y * dpr) {
        this._canvas.width = size.x * dpr;
        this._canvas.height = size.y * dpr;
        this._canvas.style.width = `${size.x}px`;
        this._canvas.style.height = `${size.y}px`;
      }
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
  let receivedAt = 0;
  let serverTime = 0;
  let selected = null;
  let onlyInView = false;
  let drawn = { xs: new Float32Array(0), ys: new Float32Array(0), idx: new Int32Array(0), n: 0 };
  let inViewCount = 0;

  const layer = new CanvasLayer(draw);

  // Estimated position now, from the last report plus speed along the heading.
  function position(a, nowMs = Date.now()) {
    if (a.onGround || !a.velocity || a.track == null) return [a.lat, a.lon];
    const age = (serverTime / 1000 - (a.timePosition ?? serverTime / 1000)) + (nowMs - receivedAt) / 1000;
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

  // Capture-phase listener so a plane wins over whatever lies under it on the map.
  const container = map.getContainer();
  container.addEventListener('click', (e) => {
    if (!map.hasLayer(layer) || map.dragging?.moved()) return;
    const a = hitTest(map.mouseEventToContainerPoint(e));
    if (!a) return;
    e.stopPropagation();
    select(a.icao24);
  }, true);
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
    const ft = a.altitude != null ? ` (${num(a.altitude * 3.28084)} ft)` : '';
    detail.show({
      key: `aircraft:${a.icao24}`,
      color: altitudeColor(a),
      kind: 'Aircraft',
      heading: a.callsign || a.icao24.toUpperCase(),
      fields: [
        ['Callsign', a.callsign || '—'],
        ['ICAO 24-bit', a.icao24.toUpperCase()],
        ['Registered in', a.country],
        ['Altitude', a.onGround ? 'On ground' : a.altitude != null ? `${num(a.altitude)} m${ft}` : '—'],
        ['Ground speed', a.velocity != null ? `${num(a.velocity * 3.6)} km/h (${num(a.velocity * 1.94384)} kt)` : '—'],
        ['Heading', a.track != null ? `${num(a.track)}°` : '—'],
        ['Vertical rate', a.verticalRate != null ? `${a.verticalRate > 0 ? '+' : ''}${num(a.verticalRate, 1)} m/s` : null],
        ['Squawk', a.squawk ? `${a.squawk}${EMERGENCY[a.squawk] ? ` · ${EMERGENCY[a.squawk]}` : ''}` : null],
        ['Category', a.category > 1 ? CATEGORY[a.category] : null],
        ['Position', latLon(lat, lon)],
        ['Last report', a.lastContact ? `${dateTime(a.lastContact * 1000)} (${timeAgo(a.lastContact * 1000)})` : '—'],
      ],
      notes: a.onGround || !a.velocity ? '' : 'Position is estimated from the last report using speed and heading.',
      link: { href: `https://globe.adsbexchange.com/?icao=${a.icao24}`, label: 'Track on ADS-B Exchange ↗' },
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
    receivedAt = Date.now();
    serverTime = data.time;
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
  const filter = el('div', { class: 'filter' }, el('label', {}, 'Only aircraft in current view', checkbox), hint);
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

  const api = {
    id: 'aircraft',
    name: 'Aircraft',
    source: 'OpenSky Network',
    color: COLOR,
    layer,
    visible: true,
    update,
    count: () => (onlyInView ? inViewCount : aircraft.length),
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
