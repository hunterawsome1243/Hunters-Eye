import * as maplibregl from 'maplibre-gl';
import { el } from './format.js';

// "You are here": a button by the zoom controls that asks the server where the
// visitor is (GET /api/whereami, from their address, city accuracy), drops a marker
// there, and flies to it. The detail card then says how far the clicked thing is.
// The place is remembered in localStorage so the marker is back on the next visit
// without another lookup; pressing the button again removes it and forgets.
// The proximity feed (ui/feed.js) measures from the same place and asks for one at
// start through locate({ fly: false }), so the globe's arrival is not interrupted.
// The button only exists when /api/config says the server can look addresses up.
const KEY = 'he.here';
const REMEMBER_MS = 24 * 3_600_000;

const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function createHere({ map, flyTo, fetchImpl = fetch, onChange = () => {} } = {}) {
  let position = null; // { lat, lon, place, at }
  let marker = null;
  let busy = false;
  let button = null;
  let error = ''; // the last lookup's failure, for the proximity feed's empty state

  function remember(p) {
    try {
      if (p) storage()?.setItem(KEY, JSON.stringify(p));
      else storage()?.removeItem(KEY);
    } catch { /* private mode or full: the marker still shows this visit */ }
  }
  function recall() {
    try {
      const p = JSON.parse(storage()?.getItem(KEY) ?? 'null');
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Date.now() - (p.at ?? 0) < REMEMBER_MS) return p;
    } catch { /* bad JSON */ }
    return null;
  }

  function place(p) {
    position = p;
    marker?.remove();
    marker = null;
    if (p && map) {
      const element = el('div', { class: 'you', title: p.place ? `You (about): ${p.place}` : 'You (about)' },
        el('i', { class: 'you-ring' }), el('i', { class: 'you-dot' }),
        el('span', { class: 'you-label' }, p.place ? `You · ${p.place.split(',')[0]}` : 'You'));
      marker = new maplibregl.Marker({ element, opacityWhenCovered: '0.15' }).setLngLat([p.lon, p.lat]).addTo(map);
    }
    button?.setAttribute('aria-pressed', String(!!p));
    onChange(p);
  }

  // Resolves to the place, or null when the lookup failed (error() says why).
  async function locate({ fly = true } = {}) {
    if (busy) return null;
    busy = true;
    button?.setAttribute('aria-busy', 'true');
    try {
      const res = await fetchImpl('/api/whereami');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const p = { lat: data.lat, lon: data.lon, place: data.place || '', at: Date.now() };
      error = '';
      remember(p);
      place(p);
      if (fly) flyTo?.({ center: [p.lon, p.lat], minZoom: 3, maxZoom: 5 });
      return p;
    } catch (err) {
      error = err.message;
      console.warn('Where am I:', err.message);
      if (button) {
        button.title = `Could not place you: ${err.message}`;
        setTimeout(() => { button.title = TITLE; }, 6000);
      }
      return null;
    } finally {
      busy = false;
      button?.removeAttribute('aria-busy');
    }
  }

  function toggle() {
    if (position) {
      remember(null);
      place(null);
    } else {
      locate();
    }
  }

  const TITLE = 'Show where you are (from your network address)';
  // The map control: one button next to the zoom group, pressed while the marker shows.
  const control = {
    onAdd() {
      this.el = el('div', { class: 'maplibregl-ctrl maplibregl-ctrl-group he-ctrl-here-group' });
      button = el('button', { type: 'button', class: 'he-ctrl-here', title: TITLE, 'aria-label': 'Show where you are', 'aria-pressed': String(!!position) });
      button.innerHTML = ICON;
      button.addEventListener('click', toggle);
      this.el.append(button);
      this.el.hidden = true; // until configure() says the server can look addresses up
      return this.el;
    },
    onRemove() {
      this.el?.remove();
      button = null;
    },
  };

  return {
    control,
    toggle,
    locate,
    position: () => position,
    error: () => error,
    // Once /api/config is in: show the button, and put back a remembered marker.
    configure(enabled) {
      if (control.el) control.el.hidden = !enabled;
      if (enabled && !position) {
        const p = recall();
        if (p) place(p);
      }
    },
  };
}
