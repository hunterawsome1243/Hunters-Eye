import { el, timeAgo } from './format.js';

// One answer to "is the picture alive?": a pill in the top bar that sums up every
// source, and a banner over the map while the server itself can't be reached.

// Non-breaking space before AM/PM so a wrapped banner never splits the time.
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }).replace(/ /g, '\u00a0');

// Pure: statuses are the /api/status rows (after any browser fallback), so tests can
// check the wording without a DOM. Returns { state, label, detail, banner }.
export function describeStatus(statuses, { serverDown = false, now = Date.now() } = {}) {
  const withData = statuses.filter((s) => s.updatedAt);
  const latest = withData.length ? Math.max(...withData.map((s) => s.updatedAt)) : null;
  if (serverDown) {
    return {
      state: 'offline',
      label: 'Offline',
      detail: latest ? `data from ${clock(latest)}` : 'no data yet',
      banner: latest ? `Can't reach the server. Showing data from ${clock(latest)}.` : "Can't reach the server.",
    };
  }
  if (!statuses.length || statuses.every((s) => s.loading)) return { state: 'loading', label: 'Connecting', detail: '', banner: null };
  const failing = statuses.filter((s) => s.error && !s.loading);
  if (failing.length) {
    const n = failing.length;
    return {
      state: 'degraded',
      label: n === statuses.length ? 'All feeds failing' : `${n} feed${n > 1 ? 's' : ''} failing`,
      detail: latest ? `updated ${timeAgo(latest, now)}` : '',
      banner: null,
    };
  }
  const stale = statuses.filter((s) => s.updatedAt && now - s.updatedAt > Math.max(3 * (s.intervalMs || 0), 5 * 60_000));
  if (stale.length) {
    const n = stale.length;
    return {
      state: 'stale',
      label: n === statuses.length ? 'All feeds stale' : `${n} feed${n > 1 ? 's' : ''} stale`,
      detail: `oldest ${timeAgo(Math.min(...stale.map((s) => s.updatedAt)), now)}`,
      banner: null,
    };
  }
  if (statuses.some((s) => s.loading)) return { state: 'loading', label: 'Loading', detail: latest ? `updated ${timeAgo(latest, now)}` : '', banner: null };
  return { state: 'live', label: 'Live', detail: `updated ${timeAgo(latest, now)}`, banner: null };
}

export function createStatus(pill, banner) {
  const dot = el('span', { class: 'dot loading' });
  const label = el('span', { class: 'label' }, 'Connecting');
  const detail = el('span', { class: 'since' });
  pill.replaceChildren(dot, label, detail);
  const bannerText = el('span', { class: 'banner-text' });
  banner.replaceChildren(el('span', { class: 'dot error' }), bannerText, el('span', { class: 'muted' }, 'Retrying…'));

  let statuses = [];
  let serverDown = false;
  const DOT = { live: 'ok', loading: 'loading', stale: 'stale', degraded: 'error', offline: 'error' };

  // Only write what changed: the banner is role="alert", and a rewrite of the same
  // sentence every tick would be announced again.
  const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  function render() {
    const d = describeStatus(statuses, { serverDown });
    pill.className = `status ${d.state}`;
    dot.className = `dot ${DOT[d.state]}`;
    set(label, d.label);
    set(detail, d.detail ? ` · ${d.detail}` : '');
    pill.title = statuses.map((s) => `${s.name}: ${s.error ? `failed (${s.error})` : s.updatedAt ? `updated ${clock(s.updatedAt)}` : 'loading'}`).join('\n');
    if (d.banner) set(bannerText, d.banner);
    banner.classList.toggle('show', !!d.banner);
  }

  setInterval(render, 5000); // keep "updated 12s ago" moving

  return {
    update(next, { serverDown: down = false } = {}) {
      serverDown = down;
      statuses = next;
      render();
    },
    render,
  };
}
