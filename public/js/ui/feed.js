import { el, num, timeAgo } from './format.js';
import { tweenNumber } from './tween.js';

const PER_SOURCE_LIMIT = 300;
const DISPLAY_LIMIT = 200;
const SETTLE_MS = 2000; // entries added this long after the first load count as "new"

// Small icons for system rows (feed failed / recovered) in place of a colour dot.
const ICONS = {
  error: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.25" fill="currentColor"/><path d="M6 3.2v3.3M6 8.4v.4" stroke="#0a0d12" stroke-width="1.6" stroke-linecap="round"/></svg>',
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
export function createFeed(listEl, countEl, { isVisible = () => true, isCurrent = () => false, onArrive = () => {} } = {}) {
  const entries = new Map();
  const nodes = new Map(); // id -> { li, button, time, entry }
  let renderQueued = false;
  let revealQueued = false;
  let loading = true; // skeleton rows while feeds are still answering (app.js setLoading)
  let settledAt = null; // when the first load finished (app.js settle)

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
    n.button = el('button', { type: 'button', onclick: e.onClick, disabled: !e.onClick, title: e.subtitle || e.title },
      swatch(e),
      el('span', { class: 'title' }, e.title),
      n.time,
      e.subtitle ? el('span', { class: 'sub' }, e.subtitle) : null,
    );
    n.li.replaceChildren(n.button);
    n.entry = e;
  }

  function render() {
    renderQueued = false;
    const now = Date.now();
    const visible = [...entries.values()].filter((e) => e.system || isVisible(e)).sort((a, b) => b.time - a.time);
    const shown = visible.slice(0, DISPLAY_LIMIT);
    // An entry whose row a filter or a layer toggle hides when it lands is not news when
    // the row appears later: the reader's own change brought it, nothing happened just now.
    const shownIds = new Set(shown.map((e) => e.id));
    for (const e of entries.values()) if (!shownIds.has(e.id)) e.quiet = true;
    tweenNumber(countEl, visible.length, { format: (v) => (v ? `(${num(v)})` : '') });
    if (!shown.length) {
      nodes.clear();
      if (loading) {
        listEl.replaceChildren(...[62, 48, 70, 55].map((w, i) =>
          el('li', { class: 'skeleton', style: `--i:${i};--w:${w}%`, 'aria-hidden': 'true' }, el('i', { class: 'swatch' }), el('i', { class: 't' }), el('i', { class: 'time' }), el('i', { class: 's' }))));
      } else {
        listEl.replaceChildren(el('li', { class: 'feed-empty' }, 'Waiting for events…'));
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

  return {
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
  };
}
