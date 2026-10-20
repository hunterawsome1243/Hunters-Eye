import * as maplibregl from 'maplibre-gl';
import { el, latLon, timeAgo } from './format.js';
import { IMAGE_CORNERS, RAMPS, compass, convert, formatValue, localUnits, nightPolygon, paintField, probe, rampCss, unitLabel } from '../overlays/field.js';
import { FIELDS, createGridLoader, describeError } from '../../../shared/openmeteo.js';

// Overlays: an "Overlays" button at the top left of the globe that opens a menu of
// washes drawn over the planet, under the data. One weather field at a time
// (temperature, wind, rain or cloud: the server's Open-Meteo grid, interpolated and
// painted into a Mercator image), plus the night side (computed here, where the Sun
// is right now) and fires (NASA's VIIRS thermal anomalies of the last day, as tiles).
// The choice is remembered in localStorage. A legend sits under the button while a
// weather field is on, so the colours can be read without opening the menu, and a
// tap on the bare planet opens a readout of the grid at that spot: the field's
// number first, the other fields under it, a Copy button for the line.
const KEY = 'he.overlays';
const WEATHER_SRC = 'he-overlay-weather';
const NIGHT_SRC = 'he-overlay-night';
const FIRES_SRC = 'he-overlay-fires';
const SLOT = 'he-overlay-slot'; // a hidden layer added first after each style load; the overlays go under it, so under every data layer
const IMAGE_W = 1024;
const IMAGE_H = 512;
const NIGHT_EVERY_MS = 60_000;
const FIRES_FAILURES = 6; // tile errors within a minute before the overlay says the tiles are not reachable
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_Thermal_Anomalies_375m_All/default/{time}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';

const WEATHER = [
  ['temperature', 'Temperature', 'Air temperature now, 2 m above ground'],
  ['wind', 'Wind', 'Wind speed now, 10 m above ground'],
  ['rain', 'Rain', 'Precipitation in the last hour'],
  ['clouds', 'Clouds', 'Cloud cover now'],
];
const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3.5 3 8.5l9 5 9-5-9-5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m3 12.5 9 5 9-5M3 16.5l9 5 9-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" opacity="0.6"/></svg>';

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

// Yesterday in UTC: the last day whose fire detections are complete.
export function firesDay(now = Date.now()) {
  return new Date(now - 86_400_000).toISOString().slice(0, 10);
}

// Whether the server's answer leaves the browser to fetch the grid itself: the
// server has no grid at all, or an old or unfinished one with a failure it will
// not retry for a while (Open-Meteo's hourly or daily limit for its address). A
// minute's pause after a wave is the server's business.
export function serverOut(answer) {
  if (!answer || !(answer.done > 0)) return true;
  return !!answer.error && !!(answer.stale || answer.partial) && (answer.retryInMs ?? 0) > 5 * 60_000;
}

export function createOverlays({ map, globe, fetchImpl = fetch, clockOffset = () => 0, locale = navigator.language } = {}) {
  const state = { weather: null, night: false, fires: false, ...recall() };
  const units = localUnits(locale);
  let weatherEnabled = null; // from /api/config; null until it answers
  let grid = null; // the grid: { at, updated, grid, fields, partial, refreshMs, stale, via? }
  let gridError = '';
  let direct = null; // this browser's own loader, from /api/config, for when the server's address is used up
  let lastAnswer = null; // the server's last answer, reused until serverAgain
  let serverAgain = 0; // the server said it would not ask Open-Meteo before this, so there is nothing new to ask it for
  let loading = null;
  let painted = ''; // which field the map's image source currently shows
  const images = { of: '', urls: new Map() }; // each field painted from the grid version `of`, as a PNG; a switch back or a style reload reuses it
  let menu = null; // the popover's controls, built once so a keyboard user's focus survives a refresh
  let nightTimer = 0;
  let weatherTimer = 0;
  let fireFailures = [];
  let firesDown = false;
  let button = null;
  let legendEl = null;
  let popover = null;
  let open = false;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (canvas) { canvas.width = IMAGE_W; canvas.height = IMAGE_H; }

  function recall() {
    try {
      const s = JSON.parse(storage()?.getItem(KEY) ?? 'null');
      if (!s || typeof s !== 'object') return {};
      return { weather: RAMPS[s.weather] ? s.weather : null, night: !!s.night, fires: !!s.fires };
    } catch {
      return {};
    }
  }
  function remember() {
    try {
      storage()?.setItem(KEY, JSON.stringify(state));
    } catch { /* private mode or full */ }
  }
  // The grid this browser fetched itself, kept for its other tabs and its next
  // page load (about 20 KB), so a reload does not buy it again.
  const gridStore = {
    load: () => JSON.parse(storage()?.getItem(`${KEY}.grid`) ?? 'null'),
    save: (g) => storage()?.setItem(`${KEY}.grid`, JSON.stringify(g)),
  };

  const ready = () => !!globe?.ready && !!map;
  // Overlay layers are added later than the data layers (a grid arrives, a box is
  // ticked), so they go under the slot instead of under the tier's, which would put
  // them on top of the weather polygons.
  function addLayer(spec) {
    if (map.getLayer(spec.id)) return;
    if (map.getLayer(SLOT)) map.addLayer(spec, SLOT);
    else globe.addLayer(spec, 'shapes');
  }
  const anyOn = () => !!(state.weather || state.night || state.fires);

  // --- the weather grid -------------------------------------------------------
  // The server keeps one grid for everyone. When its address has used up Open-
  // Meteo's allowance (a shared host's address serves other people's apps too) or
  // it cannot reach Open-Meteo at all, this browser fetches the grid itself, in
  // the same waves, on its own address and allowance, the way planes and
  // satellites fall back (public/js/fallback.js); the menu and the readout say so.
  async function loadGrid() {
    if (loading) return loading;
    loading = (async () => {
      let answer;
      if (lastAnswer && Date.now() < serverAgain) {
        answer = lastAnswer;
      } else {
        try {
          const res = await fetchImpl('/api/overlays/weather');
          const data = await res.json().catch(() => ({}));
          answer = res.ok ? data : { done: 0, error: (data.error || `HTTP ${res.status}`).replace(/^Weather grid unavailable: /, ''), retryInMs: data.retryInMs ?? 0 };
        } catch {
          answer = { done: 0, error: "can't reach the server", retryInMs: 0 }; // not the browser's "Failed to fetch"
        }
        lastAnswer = answer;
        serverAgain = Date.now() + (answer.retryInMs ?? 0);
      }
      try {
        // A whole, fresh grid of this browser's own is never traded for the
        // server's old or unfinished one.
        const mine = grid?.via === 'browser' && !grid.partial && Date.now() - grid.at < grid.refreshMs;
        if (direct && (serverOut(answer) || (mine && (answer.stale || answer.partial)))) {
          try {
            const g = await direct.current();
            // A copy of the points as they are now: the loader keeps writing a wave's
            // answers into its own arrays, and the images painted from this grid are
            // kept under its `updated`, which has to describe what they show.
            const fields = Object.fromEntries(FIELDS.map((f) => [f, g.fields[f].slice()]));
            grid = { ...g, fields, stale: Date.now() - g.at >= g.refreshMs, via: 'browser' };
            gridError = direct.lastError && (grid.partial || grid.stale) ? `last refresh failed (${describeError(direct.lastError)})` : '';
          } catch (err) {
            const both = `${answer.error}; your browser's request failed too (${describeError(err)})`;
            if (!(answer.done > 0)) throw new Error(both);
            grid = answer; // the server's old grid is better than nothing
            gridError = both;
          }
        } else if (answer.done > 0) {
          grid = answer;
          gridError = answer.error && (answer.stale || answer.partial) ? `last refresh failed (${answer.error})` : '';
        } else {
          throw new Error(answer.error);
        }
        paint();
        scheduleWeather(); // a partial grid is asked for again soon, a whole one when it is old
      } catch (err) {
        gridError = err.message;
        console.warn('Weather overlay:', err.message);
      } finally {
        loading = null;
        renderMenu();
        renderLegend();
        renderProbe(); // an open readout follows the grid: a wave arriving, a refresh, a failure
      }
    })();
    return loading;
  }
  // fetch for the shared loader, in the shape server/lib/http.js gives it: the
  // status and a line of the body on a refusal; a long pause after a network
  // failure, since a site that refuses other web pages' requests will not change
  // its mind in a minute.
  async function browserJson(url, { timeoutMs = 15_000 } = {}) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout?.(timeoutMs) });
      if (res.ok) return await res.json(); // the timeout can also fire here, mid-body, as an AbortError
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const why = timedOut ? `no answer within ${timeoutMs / 1000} s`
        : err?.name === 'SyntaxError' ? `${new URL(url).host} sent an answer that is not JSON`
          : res ? 'the connection dropped before the answer was complete'
            : 'refused or unreachable (the site may not accept requests from other web pages)';
      const e = new Error(why);
      e.retryAfterMs = timedOut || !res ? 10 * 60_000 : 60_000;
      throw e;
    }
    const body = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ').trim();
    const e = new Error(`${new URL(url).host} answered HTTP ${res.status}${body ? `: ${body}` : ''}`);
    e.status = res.status;
    throw e;
  }
  // While a field shows, ask again once the grid is older than its refresh. The
  // server sends a grid in waves a minute apart (the poles last), so a partial
  // grid is asked for again every few seconds until it is whole.
  function scheduleWeather() {
    clearTimeout(weatherTimer);
    if (!state.weather || globalThis.document?.hidden) return; // a hidden tab picks up when shown
    let wait = 60_000;
    if (grid?.partial) wait = gridError ? 60_000 : 15_000;
    else if (grid) wait = Math.max(30_000, grid.refreshMs - (Date.now() - grid.at));
    weatherTimer = setTimeout(() => { loadGrid().then(scheduleWeather); }, wait);
  }

  // Painting half a million pixels and encoding them takes a noticeable moment on a
  // phone, so each field is painted once per grid: switching back to a field, or a
  // style reload (the basemap arriving at startup), hands the map the same image again.
  function paint() {
    if (!state.weather || !grid || !canvas || !ready()) return;
    const version = String(grid.updated ?? grid.at);
    const key = `${state.weather}:${version}`;
    if (painted === key) return;
    if (images.of !== version) { images.of = version; images.urls.clear(); }
    let url = images.urls.get(state.weather);
    if (!url) {
      const ctx2d = canvas.getContext('2d');
      const pixels = ctx2d.createImageData(IMAGE_W, IMAGE_H);
      paintField(grid.grid, grid.fields[state.weather], RAMPS[state.weather], IMAGE_W, IMAGE_H, pixels.data);
      ctx2d.putImageData(pixels, 0, 0);
      url = canvas.toDataURL('image/png');
      images.urls.set(state.weather, url);
    }
    const src = map.getSource(WEATHER_SRC);
    if (src) src.updateImage({ url, coordinates: IMAGE_CORNERS });
    else globe.addSource(WEATHER_SRC, { type: 'image', url, coordinates: IMAGE_CORNERS });
    addLayer({ id: WEATHER_SRC, type: 'raster', source: WEATHER_SRC, paint: { 'raster-opacity': 0.62, 'raster-resampling': 'linear', 'raster-fade-duration': 300 } });
    painted = key;
  }

  // --- the night side --------------------------------------------------------
  function nightNow() {
    return nightPolygon(new Date(Date.now() + clockOffset()));
  }
  function mountNight() {
    if (!ready()) return;
    const feature = nightNow();
    const src = map.getSource(NIGHT_SRC);
    if (src) src.setData(feature);
    else globe.addSource(NIGHT_SRC, { type: 'geojson', data: feature });
    addLayer({ id: NIGHT_SRC, type: 'fill', source: NIGHT_SRC, paint: { 'fill-color': '#05070b', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 6, 0.35, 10, 0.15], 'fill-antialias': false } });
  }
  function scheduleNight() {
    clearInterval(nightTimer);
    nightTimer = 0;
    if (!state.night) return;
    nightTimer = setInterval(() => { if (ready() && map.getSource(NIGHT_SRC)) map.getSource(NIGHT_SRC).setData(nightNow()); }, NIGHT_EVERY_MS);
  }

  // --- fires -----------------------------------------------------------------
  function mountFires() {
    if (!ready()) return;
    globe.addSource(FIRES_SRC, { type: 'raster', tiles: [GIBS.replace('{time}', firesDay())], tileSize: 256, minzoom: 1, maxzoom: 8, attribution: 'Fires: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS / VIIRS</a>' });
    addLayer({ id: FIRES_SRC, type: 'raster', source: FIRES_SRC, paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0 } });
  }
  map?.on('error', (e) => {
    if (e.sourceId !== FIRES_SRC || firesDown) return;
    const now = Date.now();
    fireFailures = fireFailures.filter((t) => now - t < 60_000);
    fireFailures.push(now);
    if (fireFailures.length < FIRES_FAILURES) return;
    firesDown = true;
    renderMenu();
  });

  // --- mounting: after every style load, and on every change ------------------
  function setVisible(id, on) {
    if (ready() && map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  function apply() {
    if (!ready()) return;
    if (state.weather) {
      if (grid) paint();
      else loadGrid();
    }
    setVisible(WEATHER_SRC, !!state.weather && painted.startsWith(`${state.weather}:`));
    if (state.night) mountNight();
    setVisible(NIGHT_SRC, state.night);
    if (state.fires) mountFires();
    setVisible(FIRES_SRC, state.fires);
  }
  function mount() {
    painted = ''; // a new style has no image source
    globe.addLayer({ id: SLOT, type: 'background', layout: { visibility: 'none' } }, 'shapes');
    apply();
    scheduleWeather(); // a remembered field keeps refreshing even if /api/config never answers
  }
  globe?.onStyle(mount);

  function set(patch) {
    Object.assign(state, patch);
    remember();
    apply();
    scheduleNight();
    scheduleWeather();
    renderMenu();
    renderLegend();
    renderProbe();
  }

  // --- the readout: a tap on the planet reads the grid at that spot ------------
  let probeAt = null; // { lat, lon } while a readout is open
  let popup = null;
  let probeDot = null;
  let probeTick = null; // keeps the "ago" line honest while a readout stays open
  function hideProbe() {
    const p = popup;
    popup = null;
    probeAt = null;
    clearInterval(probeTick);
    probeTick = null;
    probeDot?.remove();
    probeDot = null;
    // Focus that was on the Copy button goes back to the globe, not to the page.
    const hadFocus = !!p?.getElement()?.contains(document.activeElement);
    p?.remove(); // its 'close' event comes back here and finds nothing left to do
    if (hadFocus) map?.getCanvas().focus({ preventScroll: true });
    globe?.blockSpin?.('probe', false);
  }
  function showProbe(lat, lon) {
    if (!state.weather || !map) return;
    probeAt = { lat, lon };
    if (!popup) {
      // focusAfterOpen is off so a tap keeps the keyboard on the globe and a field
      // change does not pull focus out of the menu; the popup fades with its dot
      // when the spot turns behind the planet.
      popup = new maplibregl.Popup({ className: 'probe-popup', closeButton: true, closeOnClick: false, closeOnMove: false, focusAfterOpen: false, locationOccludedOpacity: 0.15, maxWidth: '280px', offset: 12 });
      popup.on('close', hideProbe);
      probeDot = new maplibregl.Marker({ element: el('div', { class: 'probe-dot' }), opacityWhenCovered: '0.15' });
      probeTick = setInterval(renderProbeNote, 30_000);
      globe?.blockSpin?.('probe', true); // like the detail card: the spin would carry the spot away
    }
    probeDot.setLngLat([lon, lat]).addTo(map);
    popup.setLngLat([lon, lat]).setDOMContent(probeContent());
    // addTo() on an open popup removes it first, and that fires 'close' into
    // hideProbe half way through; an open popup is only moved.
    if (!popup.isOpen()) popup.addTo(map);
  }
  function renderProbe() {
    if (!probeAt) return;
    if (!state.weather) return hideProbe();
    popup?.setDOMContent(probeContent());
  }
  function renderProbeNote() {
    const span = popup?.getElement()?.querySelector('.probe-note > span');
    if (span && probeAt) span.textContent = probeNote(grid ? probe(grid, probeAt.lat, probeAt.lon) : null);
  }
  function probeNote(r) {
    if (!grid) return gridError ? `Weather grid unavailable: ${gridError}.` : 'Loading the weather grid…';
    if (!r) return gridError ? `No reading here yet: ${gridError}.` : 'No reading here yet: this band of the grid is still on its way.';
    return `From the ${grid.grid.step}° grid, ${timeAgo(grid.updated ?? grid.at)}${grid.via === 'browser' ? ', via your browser' : ''}.`;
  }
  function probeContent() {
    const { lat, lon } = probeAt;
    const field = state.weather;
    const name = WEATHER.find((w) => w[0] === field)[1];
    const r = grid ? probe(grid, lat, lon) : null;
    const value = (id) => { const v = r?.[id]; return v == null ? null : `${formatValue(id, v, units)} ${unitLabel(id, units)}`; };
    const from = r?.windDir == null ? '' : ` from ${compass(r.windDir)}`;
    const big = value(field) == null ? '—' : value(field) + (field === 'wind' ? from : '');
    const others = WEATHER.filter((w) => w[0] !== field).map(([id, n]) => (value(id) == null ? null : `${n} ${value(id)}${id === 'wind' ? from : ''}`)).filter(Boolean).join(' · ');
    const line = `${name} ${big} at ${latLon(lat, lon)}${others ? ` · ${others}` : ''}`;
    const copy = el('button', { type: 'button', class: 'probe-copy', title: 'Copy this reading' }, 'Copy');
    copy.addEventListener('click', async () => {
      copy.textContent = (await copyText(line)) ? 'Copied' : 'Copy failed';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
    return el('div', { class: 'probe', role: 'status' },
      el('div', { class: 'probe-value' }, big),
      el('div', { class: 'probe-sub' }, `${name} · ${latLon(lat, lon)}`),
      others ? el('div', { class: 'probe-others' }, others) : null,
      el('div', { class: 'probe-note' }, el('span', {}, probeNote(r)), r ? copy : null),
    );
  }
  // The clipboard API exists only on https and localhost; a phone reaching the
  // server over plain http gets the old way, a selected box and execCommand.
  async function copyText(text) {
    try {
      if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* refused: try the old way */ }
    try {
      const box = el('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0' });
      box.value = text;
      document.body.append(box);
      box.select();
      box.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      box.remove();
      return ok;
    } catch { return false; }
  }
  globe?.onMiss?.((e) => {
    if (!state.weather) return;
    const { lat, lng } = e.lngLat.wrap();
    showProbe(lat, lng);
  });

  // --- the menu --------------------------------------------------------------
  function gridNote() {
    if (weatherEnabled === null) return 'Asking the server about its weather grid…';
    if (!weatherEnabled) return 'The server has no weather grid (OPEN_METEO_URL is empty).';
    if (loading && !grid) return 'Loading the weather grid…';
    if (!grid) return gridError ? `Weather grid unavailable: ${gridError}` : 'Open-Meteo, current conditions on a 10° grid.';
    const when = `updated ${timeAgo(grid.updated ?? grid.at)}`;
    const from = grid.via === 'browser' ? 'Open-Meteo via your browser' : 'Open-Meteo';
    if (gridError) return `${from}, ${when}; ${gridError}.`;
    if (grid.partial) return `${from}, ${when}; the far north and south are on their way.`;
    return `${from}, current conditions, ${when}.`;
  }
  // The controls are built once and patched after: rebuilding them while the menu
  // is open would throw away the input a keyboard user is on after every arrow key.
  function buildMenu() {
    const inputs = new Map();
    const weatherRows = [['', 'None', 'No weather wash'], ...WEATHER].map(([id, name, hint]) => {
      const input = el('input', { type: 'radio', name: 'he-overlay-weather', value: id });
      input.addEventListener('change', () => { if (input.checked) set({ weather: id || null }); });
      inputs.set(id, input);
      return el('label', { class: 'overlay-row', title: hint }, input, el('span', {}, name));
    });
    const night = el('input', { type: 'checkbox' });
    night.addEventListener('change', () => set({ night: night.checked }));
    const fires = el('input', { type: 'checkbox' });
    fires.addEventListener('change', () => { firesDown = false; fireFailures = []; set({ fires: fires.checked }); });
    const note = el('div', { class: 'hint overlay-note' });
    const firesNote = el('div', { class: 'hint overlay-note' }, 'The fire tiles (NASA GIBS) are not reachable right now.');
    popover.replaceChildren(
      el('div', { class: 'popover-title' }, 'Overlays'),
      el('div', { class: 'overlay-group', role: 'radiogroup', 'aria-label': 'Weather overlay' }, el('div', { class: 'overlay-head' }, 'Weather'), ...weatherRows),
      note,
      el('div', { class: 'overlay-group' }, el('div', { class: 'overlay-head' }, 'Also'),
        el('label', { class: 'overlay-row', title: 'The half of the planet in darkness right now' }, night, el('span', {}, 'Night side')),
        el('label', { class: 'overlay-row', title: 'Active fires and hot spots detected by NASA\'s VIIRS satellites in the last day' }, fires, el('span', {}, 'Fires'), el('span', { class: 'muted' }, 'last day'))),
      firesNote,
    );
    menu = { inputs, night, fires, note, firesNote };
  }
  function renderMenu() {
    if (!popover || popover.hidden) return;
    if (!menu) buildMenu();
    for (const [id, input] of menu.inputs) {
      input.checked = (state.weather ?? '') === id;
      input.disabled = weatherEnabled === false && !!id;
    }
    menu.night.checked = state.night;
    menu.fires.checked = state.fires;
    menu.note.textContent = gridNote();
    menu.firesNote.hidden = !(state.fires && firesDown);
  }
  function renderLegend() {
    if (!legendEl) return;
    const field = state.weather;
    legendEl.hidden = !field || !grid;
    if (legendEl.hidden) return;
    const ramp = RAMPS[field];
    const name = WEATHER.find((w) => w[0] === field)[1];
    const fmt = (v) => { const c = convert(field, v, units); return field === 'rain' && units === 'us' ? c.toFixed(2) : Math.round(c).toString(); };
    legendEl.replaceChildren(
      el('span', { class: 'overlay-legend-name' }, `${name} · ${unitLabel(field, units)}`),
      el('span', { class: 'overlay-legend-bar', style: `background:${rampCss(ramp)}` }),
      el('span', { class: 'overlay-legend-ends' }, el('span', {}, fmt(ramp.min)), el('span', {}, fmt(ramp.max))),
    );
  }

  function placePopover() {
    if (!popover || !button) return;
    const r = button.getBoundingClientRect();
    popover.style.top = `${r.bottom + 6}px`;
    popover.style.maxHeight = `${Math.max(120, window.innerHeight - r.bottom - 14)}px`; // scrolls on a short screen
    popover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - popover.offsetWidth - 8))}px`;
  }
  function closeMenu() {
    if (!open) return;
    open = false;
    button?.setAttribute('aria-expanded', 'false');
    if (popover?.contains(document.activeElement)) button?.focus({ preventScroll: true });
    if (popover) popover.hidden = true;
  }
  function openMenu({ focus = false } = {}) {
    if (open) return closeMenu();
    open = true;
    button.setAttribute('aria-expanded', 'true');
    popover.hidden = false;
    renderMenu();
    placePopover();
    if (state.weather && !grid) loadGrid();
    // The chosen weather radio, the group's tab stop (a selector list would match None first).
    if (focus) (popover.querySelector('input[type=radio]:checked') ?? popover.querySelector('input'))?.focus({ preventScroll: true });
  }

  if (typeof document !== 'undefined') {
    popover = el('div', { id: 'overlays-popover', class: 'popover overlays-popover', role: 'dialog', tabindex: '-1', 'aria-label': 'Overlays' });
    popover.hidden = true;
    document.body.append(popover);
    document.addEventListener('pointerdown', (e) => {
      if (open && !popover.contains(e.target) && !button?.contains(e.target)) closeMenu();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (open) {
        e.stopPropagation();
        closeMenu();
      } else if (probeAt) {
        if (map?.getContainer().inert) return; // under the phone panel's scrim, that Escape is the panel's
        e.stopPropagation(); // the detail card keeps its own Escape for the next press
        hideProbe();
      }
    }, true);
    document.addEventListener('focusin', (e) => {
      if (open && !popover.contains(e.target) && e.target !== button) closeMenu();
    });
    // The menu sits at the end of the page, so Tab off its edge would leave for the
    // browser's toolbar. Shift+Tab before the first choice goes back to the button, and
    // Tab past the last carries on from the button to the next map control.
    popover.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const stops = [...popover.querySelectorAll('input:not(:disabled)')].filter((i) => i.type !== 'radio' || i.checked);
      if (document.activeElement !== (e.shiftKey ? stops[0] : stops.at(-1))) return;
      if (e.shiftKey) e.preventDefault();
      closeMenu(); // focus moves to the button first
    });
    window.addEventListener('resize', () => open && placePopover());
    // Hidden, the refresh waits; shown, a grid that fell due meanwhile is asked for at
    // once (a fresh wait on every show would starve a tab glanced at for seconds).
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return clearTimeout(weatherTimer);
      const due = !grid || grid.partial || Date.now() - grid.at >= grid.refreshMs;
      if (state.weather && due) loadGrid().then(scheduleWeather);
      else scheduleWeather();
    });
  }

  // The map control: the button, and the legend strip under it.
  const control = {
    onAdd() {
      this.el = el('div', { class: 'maplibregl-ctrl he-overlays' });
      const group = el('div', { class: 'maplibregl-ctrl-group' });
      button = el('button', { type: 'button', class: 'he-ctrl-overlays', title: 'Overlays: weather heat maps, night side, fires', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'overlays-popover' });
      button.innerHTML = ICON;
      button.append(el('span', {}, 'Overlays'));
      button.addEventListener('click', (e) => openMenu({ focus: e.detail === 0 }));
      group.append(button);
      legendEl = el('div', { class: 'overlay-legend', 'aria-live': 'polite' });
      legendEl.hidden = true;
      this.el.append(group, legendEl);
      renderLegend();
      return this.el;
    },
    onRemove() {
      this.el?.remove();
      button = null;
      legendEl = null;
    },
  };

  return {
    control,
    state: () => ({ ...state }),
    set,
    probe: showProbe,
    hideProbe,
    probeAt: () => probeAt,
    units: () => units,
    // Once /api/config is in: without a grid the weather choices are greyed out and a
    // remembered field is let go; the night side and fires need nothing from the server.
    configure(config) {
      weatherEnabled = !!config?.weather;
      const b = config?.browser;
      direct = weatherEnabled && b?.url
        ? createGridLoader({ url: b.url, gridDeg: b.gridDeg, refreshMin: b.refreshMin, fetchJson: browserJson, store: gridStore, onError: (err) => console.warn('Weather overlay (browser):', err.message) })
        : null;
      if (!weatherEnabled && state.weather) state.weather = null;
      set({});
    },
  };
}
