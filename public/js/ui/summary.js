import { el, timeAgo, timeUntil } from './format.js';
import { setText, tweenNumber } from './tween.js';

// The top bar: one chip per layer. The label part toggles the layer and leads with
// the count; the health part (a ring on the swatch, the freshness text) is a button
// that opens a popover with the full status, because a tooltip never shows on a phone.
export function createSummary(root, layers, { onToggle }) {
  const chips = new Map();
  let lastStatus = new Map();
  let serverDown = false;

  // One popover shared by every chip, placed under whichever health button opened it.
  // It sits right after the strip in the DOM (not inside it: the strip's edge fade
  // would mask it) so assistive tech finds it next to the chips.
  const popover = el('div', { id: 'feed-popover', class: 'popover', role: 'dialog', tabindex: '-1', 'aria-label': 'Feed status' });
  popover.hidden = true;
  root.after(popover);
  let openFor = null;
  function fillPopover(c) {
    popover.replaceChildren(...c.lines.map((line, i) => el('div', { class: i ? null : 'popover-title' }, line)));
  }
  // Under the button, kept 8px inside the viewport; measured from a clean left so a
  // previous placement can't squeeze the width.
  function place(c) {
    popover.style.left = '8px';
    const r = c.health.getBoundingClientRect();
    popover.style.top = `${r.bottom + 6}px`;
    popover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - popover.offsetWidth - 8))}px`;
  }
  function closePopover() {
    if (!openFor) return;
    const { health } = openFor;
    health.setAttribute('aria-expanded', 'false');
    openFor = null;
    if (popover.contains(document.activeElement)) health.focus({ preventScroll: true });
    popover.hidden = true;
  }
  function openPopover(c, { focus = false } = {}) {
    if (openFor === c) return closePopover();
    closePopover();
    openFor = c;
    c.health.setAttribute('aria-expanded', 'true');
    popover.setAttribute('aria-label', `${c.name} feed status`);
    fillPopover(c);
    popover.hidden = false;
    place(c);
    if (focus) popover.focus({ preventScroll: true }); // opened from the keyboard: read it next
  }
  // Capture phase, so a press on a map control (which stops clicks) still closes it.
  document.addEventListener('pointerdown', (e) => {
    if (openFor && !popover.contains(e.target) && !openFor.health.contains(e.target)) closePopover();
  }, true);
  // Escape closes just the popover when one is open; the detail card keeps its own Escape.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !openFor) return;
    e.stopPropagation();
    closePopover();
  }, true);
  document.addEventListener('focusin', (e) => {
    if (openFor && !popover.contains(e.target) && e.target !== openFor.health) closePopover();
  });
  // The popover follows its button while the strip scrolls, and goes when the button does.
  root.addEventListener('scroll', () => {
    if (!openFor) return;
    const b = openFor.health.getBoundingClientRect();
    const s = root.getBoundingClientRect();
    if (b.right <= s.left || b.left >= s.right) closePopover();
    else place(openFor);
  }, { passive: true });

  for (const layer of layers) {
    const input = el('input', { type: 'checkbox', 'aria-label': `Show ${layer.name}` });
    input.checked = layer.visible;
    const count = el('span', { class: 'count' }, '…');
    const ago = el('span', { class: 'ago' }, 'loading');
    const health = el('button', { type: 'button', class: 'chip-health', 'aria-expanded': 'false', 'aria-controls': 'feed-popover', 'aria-label': `${layer.name} feed status` }, ago);
    const chip = el('div', { class: 'chip', 'data-id': layer.id, 'data-health': 'loading' },
      el('label', { class: 'chip-toggle' },
        input,
        el('span', { class: 'swatch', style: `--c:${layer.color}` }),
        count,
        el('span', { class: 'name' }, layer.name)),
      health,
    );
    const entry = { chip, count, ago, health, name: layer.name, lines: [] };
    health.addEventListener('click', (e) => openPopover(entry, { focus: e.detail === 0 }));
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
  window.addEventListener('resize', () => {
    edges();
    if (openFor) place(openFor); // a rotation or resize moves the chips
  });
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
      if (s?.updatedAt) tweenNumber(c.count, layer.count());
      else setText(c.count, s?.error || serverDown ? '–' : '…');
      if (serverDown && !s?.updatedAt) c.ago.textContent = 'offline';
      else if (!s || s.loading) c.ago.textContent = 'loading';
      else if (s.error && !s.updatedAt) c.ago.textContent = 'failed';
      else if (st === 'stale') c.ago.textContent = `stale · ${timeAgo(s.updatedAt, now).replace(/ ago$/, '')}`;
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
    if (openFor) {
      fillPopover(openFor);
      place(openFor); // the text may have grown
    }
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
