import * as maplibregl from 'maplibre-gl';
import { el, placeError } from './format.js';

// "You are here": a button by the zoom controls that asks the server where the
// visitor is (GET /api/whereami, from their address, city accuracy), drops a marker
// there, and flies to it. A deliberate press asks the browser's own location first
// (exact, with the visitor's permission) and uses the address as the fallback; the
// automatic placement at load (the proximity feed) uses the address only. The detail card then says how far the clicked thing is.
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
  let running = null; // the lookup under way: { browser, fly, done }, so a press during it can wait for it
  let generation = 0; // a press that removes the marker drops the answer of a lookup still under way
  let button = null;
  let note = null; // a pressed crosshair's failure, beside the button for a few seconds
  let noteTimer = 0;
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
    tell(''); // a marker set or removed makes an earlier failure note stale
    position = p;
    marker?.remove();
    marker = null;
    if (p && map) {
      const element = el('div', { class: 'you', title: p.place ? `You (about): ${p.place}` : p.source === 'browser' ? 'You (from your browser)' : 'You (about)' },
        el('i', { class: 'you-ring' }), el('i', { class: 'you-dot' }),
        el('span', { class: 'you-label' }, p.place ? `You · ${p.place.split(',')[0]}` : 'You'));
      marker = new maplibregl.Marker({ element, opacityWhenCovered: '0.15' }).setLngLat([p.lon, p.lat]).addTo(map);
    }
    if (button) {
      button.setAttribute('aria-pressed', String(!!p));
      button.title = p ? TITLE_SET : TITLE;
    }
    onChange(p);
  }

  // The server's answer, from the visitor's address.
  async function fromServer() {
    const res = await fetchImpl('/api/whereami').catch(() => { throw new Error("can't reach the server"); }); // not the browser's "Failed to fetch"
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return { lat: data.lat, lon: data.lon, place: data.place || '', at: Date.now(), source: 'ip' };
  }

  // The browser's own location, which asks the visitor's permission, so only after
  // they pressed a button. Exact, but it has no city name to show.
  function fromBrowser() {
    return new Promise((resolve, reject) => {
      const geo = navigator.geolocation;
      if (!geo) return reject(new Error('this browser has no location'));
      geo.getCurrentPosition(
        ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude, place: '', at: Date.now(), source: 'browser' }),
        // Over plain http (not localhost) the browser refuses by itself, without asking.
        (err) => reject(new Error(err.code !== 1 ? err.message || 'browser location failed'
          : globalThis.isSecureContext === false ? 'the browser only shares its location with https pages'
            : 'you did not allow the browser to share your location')),
        { timeout: 12_000, maximumAge: 10 * 60_000 },
      );
    });
  }

  // Resolves to the place, or null when every way failed (error() says why).
  // browser: a deliberate press. The browser's own location comes first (exact,
  // but it asks the visitor), and the address is the fallback; so a wrong city from
  // the address can always be corrected by pressing the button. Without the flag
  // (the automatic placement at load) only the address is used: nothing prompts.
  // One lookup at a time: a call while one runs shares it (the same place, or null
  // and error()), so the feed's Try again during a crosshair lookup reports that one.
  function locate({ fly = true, browser = false } = {}) {
    if (busy) return running.done;
    running = { browser, fly, done: lookup({ fly, browser }) };
    return running.done;
  }
  async function lookup({ fly, browser }) {
    const mine = generation;
    busy = true;
    button?.setAttribute('aria-busy', 'true');
    try {
      let p;
      if (!browser) {
        p = await fromServer();
      } else {
        try {
          p = await fromBrowser();
        } catch (err) {
          try {
            p = await fromServer();
          } catch (err2) {
            throw new Error(`${err2.message}; ${err.message}`);
          }
        }
      }
      if (generation !== mine) return null; // the visitor removed the marker meanwhile
      error = '';
      remember(p);
      place(p);
      if (fly) flyHere();
      return p;
    } catch (err) {
      if (generation !== mine) return null;
      error = err.message;
      console.warn('Where am I:', err.message);
      onChange(position); // the proximity feed's empty state shows the new reason
      return null;
    } finally {
      busy = false;
      button?.removeAttribute('aria-busy');
    }
  }

  // The note is a live region that stays in the page; its bubble is added and
  // removed, so a screen reader reads each failure, the same one again included.
  function tell(text) {
    clearTimeout(noteTimer);
    note?.replaceChildren(...(text ? [el('p', { class: 'he-here-msg' }, text)] : []));
    if (text && note) noteTimer = setTimeout(() => tell(''), 10_000);
  }

  function flyHere() {
    if (position) flyTo?.({ center: [position.lon, position.lat], minZoom: 3, maxZoom: 5 });
  }

  async function toggle() {
    if (position) {
      generation++;
      remember(null);
      place(null);
      return;
    }
    tell('');
    if (busy) {
      // A press while a lookup runs waits for it. If that one already asked the
      // browser (the feed's Find me), its place or its failure is this press's
      // answer; the address-only one at load is not, so the browser is asked next,
      // and nor is one whose answer a removal dropped.
      const prior = running;
      const got = await prior.done;
      if (prior.browser && (got || error)) {
        if (got) {
          if (!prior.fly) flyHere();
        } else if (error && !position) {
          tell(placeError(error));
        }
        return;
      }
    }
    const p = await locate({ browser: true });
    if (!p && error) tell(placeError(error));
  }

  const TITLE = 'Place yourself on the globe (your browser asks first; your network address is the fallback)';
  const TITLE_SET = 'Remove the marker and forget where you are';
  // The map control: one button next to the zoom group, pressed while the marker shows.
  const control = {
    onAdd() {
      this.el = el('div', { class: 'maplibregl-ctrl he-here' });
      button = el('button', { type: 'button', class: 'he-ctrl-here', title: position ? TITLE_SET : TITLE, 'aria-label': 'Show where you are', 'aria-pressed': String(!!position) });
      button.innerHTML = ICON;
      button.addEventListener('click', toggle);
      note = el('div', { class: 'he-here-note', role: 'status' });
      this.el.append(el('div', { class: 'maplibregl-ctrl-group' }, button), note);
      this.el.hidden = true; // until configure() says the server can look addresses up
      return this.el;
    },
    onRemove() {
      this.el?.remove();
      clearTimeout(noteTimer);
      button = null;
      note = null;
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
