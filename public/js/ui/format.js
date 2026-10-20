export function timeAgo(ms, now = Date.now()) {
  if (ms == null) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function timeUntil(ms, now = Date.now()) {
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `in ${m}m` : `in ${Math.round(m / 60)}h`;
}

export function dateTime(ms) {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  });
}

export function num(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function latLon(lat, lon) {
  if (lat == null || lon == null) return '—';
  return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
}

// The copy of a longitude closest to the map centre, so items near the
// antimeridian are drawn on the side of the world the user is looking at.
export function nearLon(lon, centerLon) {
  return lon + 360 * Math.round((centerLon - lon) / 360);
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : String(c));
  return node;
}

// What a button says when its request never reached the server (fetch rejected:
// offline, the server restarting, a dropped connection), in place of the browser's
// own "Failed to fetch" / "Load failed".
export const OFFLINE = "Can't reach the server. Try again in a moment.";

// A failed "where am I" lookup as one sentence: the server's own reason already
// starts "Could not place your address…", so it isn't said twice.
export const placeError = (err) => (/^could not place/i.test(err) ? err : `Could not place you: ${err}`);
