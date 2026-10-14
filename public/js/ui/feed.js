import { el, num, timeAgo } from './format.js';
import { setText, tweenNumber } from './tween.js';
import { nearest } from './near.js';

const PER_SOURCE_LIMIT = 300;
const DISPLAY_LIMIT = 200;
const SETTLE_MS = 2000; // entries added this long after the first load count as "new"
const HERO_MAX_AGE_MS = 6 * 3_600_000; // older significant events are history, not the hero

// Small icons for system rows (feed failed / recovered, imagery switched) in place of a
// colour dot. The icon takes the row's colour, so error and warn share the "!".
const ALERT_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.25" fill="currentColor"/><path d="M6 3.2v3.3M6 8.4v.4" stroke="#0a0d12" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICONS = {
  error: ALERT_ICON,
  warn: ALERT_ICON,
  ok: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.25" fill="currentColor"/><path d="M3.6 6.2l1.7 1.6 3.1-3.4" fill="none" stroke="#0a0d12" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// Live event feed shared by every layer, newest first.
// An entry: { id, source, time, title, subtitle, color, system?, kind?, onClick?, replace? }.
// isVisible(entry) lets layers hide entries (layer off, below a filter threshold);
// isCurrent(entry) marks the row whose item the detail panel is showing.
// Rows keep their DOM nodes between renders: a new one slides in at its place, a
// revised one glows, and the row under the reader's eye stays put while rows land above.
// "New" is a property of the entry (when it was added), not of the row: rows re-shown
// after a layer toggle, an entry that landed while a filter hid its row, or a source
// that lands late in the first load, stay quiet.
// onArrive(entry) fires for the newest significant entry that lands after the first load.
// onNew(entry) fires for every non-system entry that lands after the first load (the watchlist).
// Two views of the same entries: 'live' (newest first) and 'near' (the proximity feed:
// nearest to the "you are here" marker first, with a distance on every row). here()
// gives that marker's { lat, lon } or null; locate() asks for one (ui/here.js) and
// resolves to it or null, and is what the proximity feed's own button calls.
export function createFeed(listEl, countEl, { isVisible = () => true, isCurrent = () => false, onArrive = () => {}, onNew = () => {}, here = () => null, locate = async () => null, locateError = () => '' } = {}) {
  const entries = new Map();
  const nodes = new Map(); // id -> { li, button, time, dist, entry }
  let renderQueued = false;
  let revealQueued = false;
  let loading = true; // skeleton rows while feeds are still answering (app.js setLoading)
  let settledAt = null; // when the first load finished (app.js settle)
  let mode = 'live';
  let locating = false; // the proximity feed is waiting for a place to measure from

  function prune(source) {
    const mine = [...entries.values()].filter((e) => e.source === source).sort((a, b) => b.time - a.time);
    for (const e of mine.slice(PER_SOURCE_LIMIT)) entries.delete(e.id);
  }

  function swatch(e) {
    if (e.system && ICONS[e.kind]) {
      const icon = el('span', { class: 'swatch icon', style: `--c:${e.color}` });
      icon.innerHTML = ICONS[e.kind]; // static markup above, nothing from the entry
      return icon;
    }
    return el('span', { class: 'swatch', style: `background:${e.color}` });
  }

  function fill(n, e, now) {
    n.time = el('span', { class: 'time' }, timeAgo(e.time, now));
    n.dist = el('span', { class: 'dist' });
    n.button = el('button', { type: 'button', onclick: e.onClick, disabled: !e.onClick, title: e.subtitle || e.title },
      swatch(e),
      el('span', { class: 'title' }, e.title),
      n.time,
      e.subtitle ? el('span', { class: 'sub' }, e.subtitle) : null,
      n.dist,
    );
    n.li.replaceChildren(n.button);
    n.entry = e;
  }

  // The proximity feed's own empty states: no place to measure from (with the button
  // that gets one), the lookup running, or a place but nothing positioned yet.
  function nearEmpty() {
    if (locating) return el('li', { class: 'feed-empty' }, 'Placing you…');
    if (!here()) {
      const err = locateError();
      return el('li', { class: 'feed-empty feed-locate' },
        el('span', {}, err ? (/^could not place/i.test(err) ? err : `Could not place you: ${err}`) : 'Nearest things first, measured from where you are.'),
        el('button', { type: 'button', class: 'brief-btn feed-locate-btn', onclick: () => api.locate({ browser: true }) }, err ? 'Try again' : 'Find me'),
        el('span', { class: 'muted' }, err
          ? 'Try again asks the server once more, then your browser for its own location (it will ask you first). The Live feed needs no place.'
          : 'Your place comes from your network address, city accuracy. The Live feed needs no place.'));
    }
    return el('li', { class: 'feed-empty' }, 'Nothing with a position on the feeds yet.');
  }

  function render() {
    renderQueued = false;
    const now = Date.now();
    const near = mode === 'near';
    const you = near ? here() : null;
    const visible = [...entries.values()].filter((e) => e.system || isVisible(e)).sort((a, b) => b.time - a.time);
    const shown = near ? nearest(visible, you) : visible.slice(0, DISPLAY_LIMIT);
    // An entry whose row a filter or a layer toggle hides when it lands is not news when
    // the row appears later: the reader's own change brought it, nothing happened just now.
    const shownIds = new Set(shown.map((e) => e.id));
    for (const e of entries.values()) if (!shownIds.has(e.id)) e.quiet = true;
    listEl.classList.toggle('near', near);
    if (near) {
      // The heading carries the list's reach: the count is nearly always the cap.
      const reach = shown.length ? Math.round(shown[shown.length - 1].km) : 0;
      countEl.title = shown.length ? `The ${num(shown.length)} nearest; the farthest is ${num(reach)} km away` : '';
      tweenNumber(countEl, reach, { format: (v) => (v ? `(≤ ${num(v)} km)` : '') });
    } else {
      countEl.title = '';
      tweenNumber(countEl, visible.length, { format: (v) => (v ? `(${num(v)})` : '') });
    }
    if (!shown.length) {
      nodes.clear();
      if (loading || (near && locating)) {
        listEl.replaceChildren(...[62, 48, 70, 55].map((w, i) =>
          el('li', { class: 'skeleton', style: `--i:${i};--w:${w}%`, 'aria-hidden': 'true' }, el('i', { class: 'swatch' }), el('i', { class: 't' }), el('i', { class: 'time' }), el('i', { class: 's' }))));
      } else {
        listEl.replaceChildren(near ? nearEmpty() : el('li', { class: 'feed-empty' }, 'Waiting for events…'));
      }
      return;
    }
    // The first row still in view is the anchor; after the shuffle, scroll so it hasn't moved.
    const top = listEl.scrollTop;
    const anchor = top > 0 ? [...listEl.children].find((li) => li.offsetTop + li.offsetHeight > top) : null;
    const anchorTop = anchor?.offsetTop;
    // An entry is "new" once, when its row is first built after the first load (not
    // again when a layer toggle or a filter brings the row back).
    const fresh = (t) => settledAt !== null && t > settledAt + SETTLE_MS;
    let arrived = null;
    // One hero: the newest significant entry on show (a strong quake, an Extreme or
    // Severe alert, an emergency squawk), as long as it is less than six hours old.
    // In the proximity feed that is the nearest one, which is the right hero there too.
    const hero = shown.find((e) => e.significant && !e.system && now - e.time < HERO_MAX_AGE_MS) ?? null;

    const lis = shown.map((e) => {
      let n = nodes.get(e.id);
      if (!n) {
        n = { li: el('li', { class: e.system ? 'system' : null }) };
        fill(n, e, now);
        nodes.set(e.id, n);
        if (!e.shown && !e.quiet && fresh(e.replacedAt ?? e.addedAt)) { // revised past a filter is new to the reader
          n.li.classList.add('new');
          if (e.significant) arrived ??= e; // shown is newest first
        }
        e.shown = true;
      } else if (n.entry !== e) {
        fill(n, e, now); // replaced (an earthquake's magnitude was revised)
        n.li.classList.remove('new');
        if (fresh(e.replacedAt)) n.li.classList.add('updated');
        e.shown = true;
      } else {
        n.time.textContent = timeAgo(e.time, now);
      }
      n.dist.textContent = near ? `${num(Math.round(e.km))} km ${e.dir}` : '';
      n.li.classList.toggle('hero', e === hero);
      n.li.classList.toggle('watched', !!e.watched);
      if (e === hero) n.li.style.setProperty('--c', e.color);
      if (isCurrent(e)) n.button.setAttribute('aria-current', 'true');
      else n.button.removeAttribute('aria-current');
      return n.li;
    });

    // Put the rows in order touching only the ones that moved, then drop the rest.
    listEl.querySelector('.feed-empty')?.remove();
    lis.forEach((li, i) => {
      if (listEl.children[i] !== li) listEl.insertBefore(li, listEl.children[i] ?? null);
    });
    while (listEl.children.length > lis.length) listEl.lastElementChild.remove();
    for (const [id, n] of nodes) if (!n.li.isConnected) nodes.delete(id);

    if (anchor?.isConnected && anchor.offsetTop !== anchorTop) {
      listEl.style.scrollBehavior = 'auto'; // an instant correction, not a smooth scroll
      listEl.scrollTop += anchor.offsetTop - anchorTop;
      listEl.style.scrollBehavior = '';
    }
    if (revealQueued) {
      revealQueued = false;
      listEl.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
    }
    if (arrived) onArrive(arrived);
  }

  // Let a row animate again the next time it changes. A new row runs its slide and
  // its glow together; only the glow's end (the longer one) clears the class.
  listEl.addEventListener('animationend', (e) => {
    if (e.animationName === 'feed-glow') e.target.classList.remove('new', 'updated');
  });
  // The section shows a shadow while rows are tucked under its heading.
  listEl.addEventListener('scroll', () => listEl.parentElement.classList.toggle('scrolled', listEl.scrollTop > 0), { passive: true });

  // reveal: scroll the current row into view once rendered (a map click selected it).
  function refresh({ reveal = false } = {}) {
    revealQueued ||= reveal;
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  setInterval(refresh, 30_000); // keep relative times current
  refresh(); // skeleton rows from the first frame

  const api = {
    // 'live' or 'near' (the proximity feed).
    setMode(next) {
      if (next !== 'live' && next !== 'near') return;
      if (mode === next) return;
      mode = next;
      nodes.clear(); // rows are rebuilt in the new order, without slide-ins
      for (const e of entries.values()) e.shown = true;
      listEl.replaceChildren();
      listEl.scrollTop = 0;
      setText(countEl, ''); // the other view's number must not linger a frame; the new one counts up
      refresh();
    },
    mode: () => mode,
    // Get a place for the proximity feed (its button, or app.js at start). Resolves
    // to the place or null; the empty state then shows the lookup's error.
    async locate(opts) {
      if (locating) return null;
      locating = true;
      refresh();
      try {
        return await locate(opts);
      } catch {
        return null;
      } finally {
        locating = false;
        refresh();
      }
    },
    add(entry) {
      const prior = entries.get(entry.id);
      if (prior && !entry.replace) return;
      const now = Date.now();
      entry.addedAt = prior ? prior.addedAt : now;
      if (prior) {
        entry.replacedAt = now;
        entry.shown = prior.shown; // a revision of a row the reader has seen
      }
      entries.set(entry.id, entry);
      prune(entry.source);
      if (!prior && !entry.system && settledAt !== null && now > settledAt + SETTLE_MS) onNew(entry);
      refresh();
    },
    remove(id) {
      if (entries.delete(id)) refresh();
    },
    setLoading(on) {
      if (loading === on) return;
      loading = on;
      refresh();
    },
    // The first load is done: entries from here on are news.
    settle() {
      settledAt ??= Date.now();
    },
    refresh,
    // The entries a reader currently sees, newest first (for the situation brief).
    visible: (limit = DISPLAY_LIMIT) => [...entries.values()].filter((e) => e.system || isVisible(e)).sort((a, b) => b.time - a.time).slice(0, limit),
  };
  return api;
}
