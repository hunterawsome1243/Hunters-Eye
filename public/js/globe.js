import * as maplibregl from 'maplibre-gl';
import { IMAGERY, IMAGERY_LAYER, IMAGERY_SOURCE, buildStyle, fallbackStyle, imageryLayer, imagerySource } from './globe/style.js';
import { nearLon } from './globe/geo.js';
import { createSpin } from './globe/spin.js';
import { SPACE_LAYER, spaceLayer } from './globe/space.js';

// Draw order for the data layers, bottom to top. globe.js adds one hidden
// "slot" layer per tier after every style load; ctx.addLayer(spec, tier)
// inserts a module's layer just below its slot, so weather polygons always sit
// under planes, planes under quakes and satellites, whichever module mounted
// first.
export const TIERS = ['shapes', 'tracks', 'planes', 'points', 'labels', 'top'];
const slotId = (tier) => `he-slot-${tier}`;

const IMAGERY_FAILURES = 8; // he-imagery tile errors within a minute before switching to NASA
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// The 3D globe: a MapLibre map in globe projection, with the basemap pipeline,
// click dispatch, camera helpers and the ambient spin. Layer modules never
// touch the map's style directly; they go through the ctx helpers below.
// Throws when the browser has no WebGL2.
export function createGlobe(container, { phone = false, detail, feed } = {}) {
  if (!phone && (navigator.hardwareConcurrency ?? 2) >= 6) maplibregl.setWorkerCount(2);
  if (phone) maplibregl.setMaxParallelImageRequests(8);

  const map = new maplibregl.Map({
    container,
    style: fallbackStyle(),
    center: [-20, 25],
    zoom: phone ? 1.0 : 1.8,
    minZoom: 0.8,
    maxZoom: 19,
    maxPitch: phone ? 60 : 70,
    fadeDuration: 150, // 0 would force full symbol placement every frame
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    canvasContextAttributes: { antialias: false, powerPreference: 'high-performance' },
    cancelPendingTileRequestsWhileZooming: true,
    maxTileCacheZoomLevels: phone ? 3 : 5,
    attributionControl: { compact: true },
  });

  // Spin stays off while something is looking at a spot: the detail panel, or
  // the aircraft "only in view" filter, which would refetch on every step.
  const spinBlocks = new Set();
  const spin = createSpin(map, { phone, isBlocked: () => spinBlocks.size > 0 });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new SpinControl(spin), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  // No GlobeControl: it would replace the zoom-driven projection with a plain toggle.
  // MapLibre unfolds a compact attribution when its text first arrives and leaves it
  // open until the first drag: on a phone it wraps over the scale and the globe, on a
  // desktop it is the brightest line on the screen. Start it folded behind its (i)
  // button instead; the credits are one tap away.
  {
    const fold = () => {
      const attrib = container.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show');
      if (!attrib) return;
      attrib.classList.remove('maplibregl-compact-show');
      attrib.removeAttribute('open');
      map.off('styledata', fold);
      map.off('sourcedata', fold);
    };
    map.on('styledata', fold);
    map.on('sourcedata', fold);
  }

  // --- style lifecycle --------------------------------------------------------
  let styleReady = false;
  const styleCallbacks = [];
  map.on('style.load', () => {
    // The space backdrop goes under everything, before the sphere's background layer.
    if (!map.getLayer(SPACE_LAYER)) map.addLayer(spaceLayer(), map.getStyle()?.layers?.[0]?.id);
    for (const tier of TIERS) {
      if (!map.getLayer(slotId(tier))) map.addLayer({ id: slotId(tier), type: 'background', layout: { visibility: 'none' } });
    }
    styleReady = true;
    for (const fn of styleCallbacks) fn();
  });

  // The basemap style, fetched here so it can be edited before use. When it can't
  // be fetched the continents style stays, and the data layers are unaffected.
  // MapLibre never reports a 404 tile, so a retired imagery path would leave the
  // sphere bare: probe one low-zoom tile after the style loads and fall back.
  async function probeImagery(imagery) {
    if (!imagery?.tiles || imagerySwapped) return;
    const url = imagery.tiles.replace('{z}', '2').replace('{x}', '1').replace('{y}', '1');
    try {
      const res = await fetch(url, { mode: 'cors', cache: 'force-cache' });
      if (res.status === 404 || res.status === 410) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (!/HTTP 4(04|10)/.test(err.message)) return; // network/CORS failures are counted by the error handler
      console.warn(`Imagery probe failed (${err.message}); switching to NASA Blue Marble`);
      fallbackImagery();
    }
  }

  async function loadBasemap(url, imagery) {
    let base;
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      base = await res.json();
    } catch (err) {
      console.warn('Basemap unavailable:', err.message);
      base = fallbackStyle();
    }
    styleReady = false;
    map.setStyle(buildStyle(base, { imagery }), { diff: false });
    map.once('style.load', () => probeImagery(imagery));
  }

  // Swap the imagery tiles in place (used for the automatic NASA fallback).
  function swapImagery(imagery) {
    const layers = map.getStyle()?.layers ?? [];
    const at = layers.findIndex((l) => l.id === IMAGERY_LAYER);
    const before = at >= 0 ? layers[at + 1]?.id : undefined;
    if (map.getLayer(IMAGERY_LAYER)) map.removeLayer(IMAGERY_LAYER);
    if (map.getSource(IMAGERY_SOURCE)) map.removeSource(IMAGERY_SOURCE);
    map.addSource(IMAGERY_SOURCE, imagerySource(imagery));
    map.addLayer(imageryLayer(), before);
  }

  // Tile and glyph failures are expected on a free stack: log them quietly, and
  // after enough imagery failures switch to NASA's public-domain tiles.
  let imageryFailures = [];
  let imagerySwapped = false;
  map.on('error', (e) => {
    const message = e.error?.message ?? String(e.error ?? e);
    const transient = e.error?.status != null || e.tile || e.sourceId || /tile|glyph|sprite|AJAX|Failed to fetch/i.test(message);
    if (!transient) return console.error(message, e.error);
    console.warn(`Map resource failed${e.sourceId ? ` (${e.sourceId})` : ''}: ${message}`);
    if (e.sourceId !== IMAGERY_SOURCE || imagerySwapped) return;
    const now = Date.now();
    imageryFailures = imageryFailures.filter((t) => now - t < 60_000);
    imageryFailures.push(now);
    if (imageryFailures.length < IMAGERY_FAILURES) return;
    fallbackImagery();
  });

  function fallbackImagery() {
    if (imagerySwapped || !map.getSource(IMAGERY_SOURCE)) return;
    imagerySwapped = true;
    swapImagery(IMAGERY.bluemarble);
    feed?.add({
      id: `system:imagery:${Date.now()}`,
      source: 'system',
      system: true,
      kind: 'warn',
      time: Date.now(),
      color: 'var(--warn)',
      title: 'Imagery switched to NASA Blue Marble',
      subtitle: 'The satellite imagery tiles were not reachable',
    });
  }

  // --- clicks and hover -------------------------------------------------------
  let interactive = []; // [{ layer, priority, owner }], set by app.js when visibility changes
  const missCallbacks = []; // told of a click that no layer claimed (a tap on the bare planet)
  const priorityOf = (layerId) => interactive.find((i) => i.layer === layerId)?.priority ?? 0;
  const ownerOf = (layerId) => interactive.find((i) => i.layer === layerId)?.owner;
  const activeLayers = () => interactive.filter((i) => i.owner.visible && map.getLayer(i.layer)).map((i) => i.layer);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function hitsAt(point, r) {
    const layers = activeLayers();
    if (!layers.length) return [];
    return map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers });
  }

  map.on('click', (e) => {
    const r = e.originalEvent?.pointerType === 'touch' || phone ? 14 : 8;
    const hits = hitsAt(e.point, r);
    const seen = new Set();
    const ranked = hits
      .filter((f) => {
        const k = `${f.layer.id}:${f.id ?? JSON.stringify(f.properties)}`; // tile-edge and antimeridian duplicates
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((f) => ({
        f,
        p: priorityOf(f.layer.id),
        d: f.geometry.type === 'Point' ? dist(map.project(f.geometry.coordinates), e.point) : 1e9,
      }))
      .sort((a, b) => b.p - a.p || a.d - b.d);
    for (const { f } of ranked) if (ownerOf(f.layer.id)?.pick(f, e)) return;
    detail?.hide();
    if (map.transform?.isPointOnMapSurface?.(e.point) ?? true) for (const fn of missCallbacks) fn(e);
  });

  if (matchMedia('(hover: hover)').matches) {
    let frame = null;
    map.on('mousemove', (e) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (map.isMoving() && !spin.spinning) return;
        map.getCanvas().style.cursor = hitsAt(e.point, 6).length ? 'pointer' : '';
      });
    });
  }

  // --- camera -------------------------------------------------------------------
  function flyTo({ center, zoom, minZoom = -Infinity, maxZoom = Infinity }) {
    const z = zoom ?? clamp(map.getZoom(), minZoom, maxZoom);
    spin.pause();
    const lift = phone && detail?.key ? -0.2 * map.getContainer().clientHeight : 0;
    const to = { center, zoom: z, offset: [0, lift] };
    // Under reduced motion MapLibre's flyTo becomes a jumpTo that drops the offset,
    // leaving the point under the phone's sheet; its easeTo keeps it (and jumps too).
    if (reduceMotion.matches) map.easeTo(to);
    else map.flyTo({ ...to, duration: 1000, curve: 1.3, speed: 0.9 });
  }

  function fitBounds(bounds, { maxZoom = 8, padding = 40 } = {}) {
    spin.pause();
    map.fitBounds(bounds, { maxZoom, padding, duration: 1000 });
  }

  // The visible area as { lamin, lomin, lamax, lomax }, or null when more than a
  // hemisphere is on screen. Longitudes are expressed around the centre and may
  // pass ±180; shared/opensky.js normalizes them. A steep tilt makes the far
  // edge balloon toward the horizon, so each half-span is capped there.
  function viewBounds() {
    const zoom = map.getZoom();
    if (zoom < 2.2) return null;
    const b = map.getBounds();
    const c = map.getCenter();
    let lamin = b.getSouth(), lamax = b.getNorth(), lomin = b.getWest(), lomax = b.getEast();
    // With a pole on screen the globe's bounds widen to the whole world; a tilt
    // balloons the far edge. Both cases fall back to a box around the centre.
    if (map.getPitch() > 45 || lomax - lomin >= 360) {
      const flat = (360 / 2 ** zoom) * (map.getContainer().clientWidth / 512);
      const cap = 1.5 * flat;
      lomin = Math.max(lomin, c.lng - cap);
      lomax = Math.min(lomax, c.lng + cap);
      lamin = Math.max(lamin, c.lat - cap);
      lamax = Math.min(lamax, c.lat + cap);
    }
    return { lamin: clamp(lamin, -90, 90), lomin, lamax: clamp(lamax, -90, 90), lomax };
  }

  function contains(lon, lat) {
    return map.getBounds().contains([nearLon(lon, map.getCenter().lng), lat]);
  }

  // moveend without the spin's own steps, debounced.
  function onView(fn, wait = 150) {
    let timer = null;
    map.on('moveend', (e) => {
      if (e.spin) return;
      clearTimeout(timer);
      timer = setTimeout(() => fn(e), wait);
    });
  }

  return {
    map,
    spin,
    TIERS,
    // True between a style's 'style.load' and the next setStyle. Filters,
    // layout properties and feature state can only be set while it is true.
    get ready() {
      return styleReady;
    },
    onStyle(fn) {
      styleCallbacks.push(fn);
      if (styleReady) fn();
    },
    loadBasemap,
    swapImagery,
    setInteractive(list) {
      interactive = list;
    },
    onMiss(fn) {
      missCallbacks.push(fn);
    },
    blockSpin(key, on) {
      if (on) spinBlocks.add(key);
      else spinBlocks.delete(key);
      if (on) spin.pause();
      else if (!spinBlocks.size) spin.resume();
    },
    hasGlyphs: () => !!map.getStyle()?.glyphs,
    addSource(id, spec) {
      if (!map.getSource(id)) map.addSource(id, spec);
    },
    addLayer(spec, tier) {
      if (map.getLayer(spec.id)) return;
      const slot = slotId(tier);
      map.addLayer(spec, map.getLayer(slot) ? slot : undefined);
    },
    addImage(id, image, opts) {
      if (!map.hasImage(id)) map.addImage(id, image, opts);
    },
    flyTo,
    fitBounds,
    viewBounds,
    contains,
    onView,
    ripple,
  };

  // A short pulse where a selected point sits (style.css .ripple), so a feed click
  // shows where it landed. latlng is [lat, lon]; radius is the marker's, so the
  // ring starts just outside it. An arrival pulses a third time.
  // A selection flies the camera there right after this call, so the pulse waits
  // for the flight to land: on a globe the point is often on the far side until
  // then. A point that is still behind the globe is not drawn at all.
  function ripple([lat, lon], color, radius = 8, { arrive = false } = {}) {
    const show = () => {
      const element = document.createElement('div');
      element.className = arrive ? 'ripple arrive' : 'ripple';
      element.style.setProperty('--size', `${Math.round(radius * 2 + 8)}px`);
      const ring = document.createElement('i');
      ring.style.setProperty('--c', color);
      element.append(ring);
      const marker = new maplibregl.Marker({ element, opacityWhenCovered: '0' }).setLngLat([lon, lat]).addTo(map);
      setTimeout(() => marker.remove(), arrive ? 2200 : 1500);
    };
    setTimeout(() => (map.isMoving() && !spin.spinning ? map.once('moveend', show) : show()));
  }
}

// The auto-rotate button next to the zoom controls.
class SpinControl {
  constructor(spin) {
    this.spin = spin;
  }
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'he-ctrl-spin';
    btn.title = 'Auto-rotate';
    btn.setAttribute('aria-label', 'Auto-rotate the globe');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 12a8 3 0 0 0 16 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2"/><path d="M19 4l1.5 3.5L17 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    // The spin never runs under reduced motion, so the control is off and
    // disabled there instead of claiming to be on.
    const show = () => {
      btn.disabled = reduceMotion.matches;
      btn.title = reduceMotion.matches ? 'Auto-rotate is off while reduced motion is on' : 'Auto-rotate';
      btn.setAttribute('aria-pressed', String(this.spin.on && !reduceMotion.matches));
    };
    show();
    this.spin.onChange(show);
    reduceMotion.addEventListener('change', show);
    btn.addEventListener('click', () => this.spin.set(!this.spin.on));
    this.el.append(btn);
    return this.el;
  }
  onRemove() {
    this.el?.remove();
  }
}
