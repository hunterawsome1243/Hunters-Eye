import { el, timeAgo } from './format.js';

const PER_SOURCE_LIMIT = 300;
const DISPLAY_LIMIT = 200;

// Live event feed shared by every layer, newest first.
// An entry: { id, source, time, title, subtitle, color, system?, onClick? }.
// isVisible(entry) lets layers hide entries (layer off, below a filter threshold);
// isCurrent(entry) marks the row whose item the detail panel is showing.
export function createFeed(listEl, countEl, { isVisible = () => true, isCurrent = () => false } = {}) {
  const entries = new Map();
  let renderQueued = false;
  let revealQueued = false;

  function prune(source) {
    const mine = [...entries.values()].filter((e) => e.source === source).sort((a, b) => b.time - a.time);
    for (const e of mine.slice(PER_SOURCE_LIMIT)) entries.delete(e.id);
  }

  function render() {
    renderQueued = false;
    const visible = [...entries.values()].filter((e) => e.system || isVisible(e)).sort((a, b) => b.time - a.time);
    const shown = visible.slice(0, DISPLAY_LIMIT);
    countEl.textContent = visible.length ? `(${visible.length})` : '';
    if (!shown.length) {
      listEl.replaceChildren(el('li', { class: 'feed-empty' }, 'Waiting for events…'));
      return;
    }
    const now = Date.now();
    listEl.replaceChildren(
      ...shown.map((e) =>
        el('li', { class: e.system ? 'system' : null },
          el('button', { type: 'button', onclick: e.onClick, disabled: !e.onClick, title: e.subtitle || e.title, 'aria-current': isCurrent(e) ? 'true' : null },
            el('span', { class: 'swatch', style: `background:${e.color}` }),
            el('span', { class: 'title' }, e.title),
            el('span', { class: 'time' }, timeAgo(e.time, now)),
            e.subtitle ? el('span', { class: 'sub' }, e.subtitle) : null,
          ),
        ),
      ),
    );
    if (revealQueued) {
      revealQueued = false;
      listEl.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
    }
  }

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
