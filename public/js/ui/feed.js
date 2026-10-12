import { el, timeAgo } from './format.js';

const PER_SOURCE_LIMIT = 300;
const DISPLAY_LIMIT = 200;
const SETTLE_MS = 2000; // rows arriving after the first fill count as "new"

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
export function createFeed(listEl, countEl, { isVisible = () => true, isCurrent = () => false } = {}) {
  const entries = new Map();
  const nodes = new Map(); // id -> { li, button, time, entry }
  let renderQueued = false;
  let revealQueued = false;
  let settledAt = null; // when the first non-empty render happened

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
    countEl.textContent = visible.length ? `(${visible.length})` : '';
    if (!shown.length) {
      nodes.clear();
      listEl.replaceChildren(el('li', { class: 'feed-empty' }, 'Waiting for events…'));
      return;
    }
    // The first row still in view is the anchor; after the shuffle, scroll so it hasn't moved.
    const top = listEl.scrollTop;
    const anchor = top > 0 ? [...listEl.children].find((li) => li.offsetTop + li.offsetHeight > top) : null;
    const anchorTop = anchor?.offsetTop;
    const animate = settledAt !== null && now - settledAt > SETTLE_MS;

    const lis = shown.map((e) => {
      let n = nodes.get(e.id);
      if (!n) {
        n = { li: el('li', { class: e.system ? 'system' : null }) };
        fill(n, e, now);
        nodes.set(e.id, n);
        if (animate) n.li.classList.add('new');
      } else if (n.entry !== e) {
        fill(n, e, now); // replaced (an earthquake's magnitude was revised)
        if (animate) n.li.classList.add('updated');
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
    if (settledAt === null) settledAt = now;
    if (revealQueued) {
      revealQueued = false;
      listEl.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
    }
  }

  // Let a row animate again the next time it changes.
  listEl.addEventListener('animationend', (e) => e.target.classList?.remove('new', 'updated'));
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

  return {
    add(entry) {
      if (entries.has(entry.id) && !entry.replace) return;
      entries.set(entry.id, entry);
      prune(entry.source);
      refresh();
    },
    remove(id) {
      if (entries.delete(id)) refresh();
    },
    refresh,
  };
}
