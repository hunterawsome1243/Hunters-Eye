import { el, timeAgo } from './format.js';
import { IMAGE_CORNERS, RAMPS, convert, localUnits, nightPolygon, paintField, rampCss, unitLabel } from '../overlays/field.js';

// Overlays: an "Overlays" button at the top left of the globe that opens a menu of
// washes drawn over the planet, under the data. One weather field at a time
// (temperature, wind, rain or cloud: the server's Open-Meteo grid, interpolated and
// painted into a Mercator image), plus the night side (computed here, where the Sun
// is right now) and fires (NASA's VIIRS thermal anomalies of the last day, as tiles).
// The choice is remembered in localStorage. A legend sits under the button while a
// weather field is on, so the colours can be read without opening the menu.
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

export function createOverlays({ map, globe, fetchImpl = fetch, clockOffset = () => 0, locale = navigator.language } = {}) {
  const state = { weather: null, night: false, fires: false, ...recall() };
  const units = localUnits(locale);
  let weatherEnabled = null; // from /api/config; null until it answers
  let grid = null; // the server's answer: { at, grid, fields, refreshMs, stale }
  let gridError = '';
  let loading = null;
  let painted = ''; // which field the map's image source currently shows
  let image = { key: '', url: '' }; // the last field painted, as a PNG; a style reload reuses it instead of painting again
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
  async function loadGrid() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const res = await fetchImpl('/api/overlays/weather');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        grid = data;
        gridError = data.error && data.stale ? `last refresh failed (${data.error})` : '';
        painted = '';
        paint();
      } catch (err) {
        gridError = err.message;
        console.warn('Weather overlay:', err.message);
      } finally {
        loading = null;
        renderMenu();
        renderLegend();
      }
    })();
    return loading;
  }
  // While a field shows, ask again once the grid is older than its refresh.
  function scheduleWeather() {
    clearTimeout(weatherTimer);
    if (!state.weather) return;
    const wait = grid ? Math.max(30_000, grid.refreshMs - (Date.now() - grid.at)) : 60_000;
    weatherTimer = setTimeout(() => { loadGrid().then(scheduleWeather); }, wait);
  }

  // Painting half a million pixels and encoding them takes a noticeable moment on a
  // phone, so a field is painted once per grid: a style reload (the basemap arriving
  // at startup) only hands the map the same image again.
  function paint() {
    if (!state.weather || !grid || !canvas || !ready()) return;
    const key = `${state.weather}:${grid.at}`;
    if (painted === key) return;
    if (image.key !== key) {
      const ctx2d = canvas.getContext('2d');
      const pixels = ctx2d.createImageData(IMAGE_W, IMAGE_H);
      paintField(grid.grid, grid.fields[state.weather], RAMPS[state.weather], IMAGE_W, IMAGE_H, pixels.data);
      ctx2d.putImageData(pixels, 0, 0);
      image = { key, url: canvas.toDataURL('image/png') };
    }
    const src = map.getSource(WEATHER_SRC);
    if (src) src.updateImage({ url: image.url, coordinates: IMAGE_CORNERS });
    else globe.addSource(WEATHER_SRC, { type: 'image', url: image.url, coordinates: IMAGE_CORNERS });
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
  }

  // --- the menu --------------------------------------------------------------
  function gridNote() {
    if (weatherEnabled === null) return 'Asking the server about its weather grid…';
    if (!weatherEnabled) return 'The server has no weather grid (OPEN_METEO_URL is empty).';
    if (loading && !grid) return 'Loading the weather grid…';
    if (!grid) return gridError ? `Weather grid unavailable: ${gridError}` : 'Open-Meteo, current conditions on a 10° grid.';
    const when = `updated ${timeAgo(grid.at)}`;
    return gridError ? `Open-Meteo, ${when}; ${gridError}.` : `Open-Meteo, current conditions, ${when}.`;
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
    if (focus) popover.querySelector('input:checked, input')?.focus({ preventScroll: true });
  }

  if (typeof document !== 'undefined') {
    popover = el('div', { id: 'overlays-popover', class: 'popover overlays-popover', role: 'dialog', tabindex: '-1', 'aria-label': 'Overlays' });
    popover.hidden = true;
    document.body.append(popover);
    document.addEventListener('pointerdown', (e) => {
      if (open && !popover.contains(e.target) && !button?.contains(e.target)) closeMenu();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !open) return;
      e.stopPropagation();
      closeMenu();
    }, true);
    document.addEventListener('focusin', (e) => {
      if (open && !popover.contains(e.target) && e.target !== button) closeMenu();
    });
    window.addEventListener('resize', () => open && placePopover());
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
    units: () => units,
    // Once /api/config is in: without a grid the weather choices are greyed out and a
    // remembered field is let go; the night side and fires need nothing from the server.
    configure(config) {
      weatherEnabled = !!config?.weather;
      if (!weatherEnabled && state.weather) state.weather = null;
      set({});
    },
  };
}
