import { el, num, timeAgo, timeUntil } from './format.js';

// The top bar: one chip per layer. The label part toggles the layer and leads with
// the count; the health part (a ring on the swatch, the freshness text) is a button
// that opens a popover with the full status, because a tooltip never shows on a phone.
export function createSummary(root, layers, { onToggle }) {
  const chips = new Map();
  let lastStatus = new Map();
  let serverDown = false;

  // One popover shared by every chip, placed under whichever health button opened it.
  const popover = el('div', { class: 'popover', role: 'dialog', 'aria-label': 'Feed status' });
  popover.hidden = true;
  document.body.append(popover);
  let openFor = null;
  function fillPopover(c) {
    popover.replaceChildren(...c.lines.map((line, i) => el('div', { class: i ? null : 'popover-title' }, line)));
  }
  function closePopover() {
    if (!openFor) return;
    openFor.health.setAttribute('aria-expanded', 'false');
    openFor = null;
    popover.hidden = true;
  }
  function openPopover(c) {
    if (openFor === c) return closePopover();
    closePopover();
    openFor = c;
    c.health.setAttribute('aria-expanded', 'true');
    fillPopover(c);
    popover.hidden = false;
    const r = c.health.getBoundingClientRect();
    popover.style.top = `${r.bottom + 6}px`;
    popover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - popover.offsetWidth - 8))}px`;
  }
  document.addEventListener('click', (e) => {
    if (openFor && !popover.contains(e.target) && !openFor.health.contains(e.target)) closePopover();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closePopover());
  root.addEventListener('scroll', closePopover, { passive: true });

  for (const layer of layers) {
    const input = el('input', { type: 'checkbox', 'aria-label': `Show ${layer.name}` });
    input.checked = layer.visible;
    const count = el('span', { class: 'count' }, '…');
    const ago = el('span', { class: 'ago' }, 'loading');
    const health = el('button', { type: 'button', class: 'chip-health', 'aria-expanded': 'false', 'aria-label': `${layer.name} feed status` }, ago);
    const chip = el('div', { class: 'chip', 'data-id': layer.id, 'data-health': 'loading' },
      el('label', { class: 'chip-toggle' },
        input,
        el('span', { class: 'swatch', style: `--c:${layer.color}` }),
        count,
        el('span', { class: 'name' }, layer.name)),
      health,
    );
    const entry = { chip, count, ago, health, lines: [] };
    health.addEventListener('click', () => openPopover(entry));
    input.addEventListener('change', () => {
      chip.classList.toggle('off', !input.checked);
      onToggle(layer, input.checked);
    });
    chip.classList.toggle('off', !input.checked);
    chips.set(layer.id, entry);
    root.append(chip);
  }

  // Fade the edges of the strip where more chips are hiding (phones and tablets).
  function edges() {
    root.classList.toggle('more-left', root.scrollLeft > 2);
    root.classList.toggle('more-right', root.scrollLeft + root.clientWidth < root.scrollWidth - 2);
  }
  root.addEventListener('scroll', edges, { passive: true });
  window.addEventListener('resize', edges);
  requestAnimationFrame(edges);

  function state(s) {
    // The banner explains a dead server; chips just show their data is ageing
    // (a source the browser is fetching itself carries on as normal).
    if (serverDown && s?.via !== 'browser') return s?.updatedAt ? 'stale' : 'loading';
    if (!s || s.loading) return 'loading';
    if (s.error) return 'error';
    // Older than three refresh intervals means something upstream is stuck.
    if (s.updatedAt && Date.now() - s.updatedAt > Math.max(3 * s.intervalMs, 5 * 60_000)) return 'stale';
    return 'ok';
  }

  function render() {
    const now = Date.now();
    for (const layer of layers) {
      const c = chips.get(layer.id);
      const s = lastStatus.get(layer.id);
      const st = state(s);
      c.chip.dataset.health = st;
      c.chip.classList.toggle('error', st === 'error');
      c.count.textContent = s?.updatedAt ? num(layer.count()) : s?.error || serverDown ? '–' : '…';
      if (serverDown && !s?.updatedAt) c.ago.textContent = 'offline';
      else if (!s || s.loading) c.ago.textContent = 'loading';
      else if (s.error && !s.updatedAt) c.ago.textContent = 'failed';
      else c.ago.textContent = timeAgo(s.updatedAt, now);
      // The browser is fetching this source itself because the server can't (fallback.js).
      if (s?.via === 'browser' && !serverDown) c.ago.textContent += ' · via browser';

      const lines = [`${layer.name} (${layer.source})`];
      if (serverDown) lines.push('Cannot reach the local server.');
      if (s?.error) lines.push(`Error: ${s.error}`, s.updatedAt ? 'Showing the last good data.' : 'No data yet.');
      if (s?.note) lines.push(s.note);
      if (s?.updatedAt) lines.push(`Updated ${new Date(s.updatedAt).toLocaleTimeString()}`);
      if (s?.nextAt) lines.push(`Next refresh ${timeUntil(s.nextAt, now)} (every ${Math.round(s.intervalMs / 1000)}s)`);
      c.lines = lines;
      c.chip.title = lines.join('\n');
    }
    if (openFor) fillPopover(openFor);
    edges();
  }

  setInterval(render, 5000);

  return {
    update(statuses, { serverDown: down = false } = {}) {
      serverDown = down;
      lastStatus = new Map(statuses.map((s) => [s.id, s]));
      render();
    },
    render,
  };
}
