import { el, num, timeAgo, timeUntil } from './format.js';

// The top bar: one chip per layer with a toggle, live count, freshness and health.
export function createSummary(root, layers, { onToggle }) {
  const chips = new Map();
  let lastStatus = new Map();
  let serverDown = false;

  for (const layer of layers) {
    const input = el('input', { type: 'checkbox', 'aria-label': `Show ${layer.name}` });
    input.checked = layer.visible;
    const dot = el('span', { class: 'dot loading' });
    const count = el('span', { class: 'count' }, '…');
    const ago = el('span', { class: 'ago' }, 'loading');
    const chip = el('label', { class: 'chip', 'data-id': layer.id },
      input,
      el('span', { class: 'swatch', style: `background:${layer.color}` }),
      el('span', { class: 'name' }, layer.name),
      count,
      el('span', { class: 'meta' }, dot, ago),
    );
    input.addEventListener('change', () => {
      chip.classList.toggle('off', !input.checked);
      onToggle(layer, input.checked);
    });
    chip.classList.toggle('off', !input.checked);
    chips.set(layer.id, { chip, dot, count, ago });
    root.append(chip);
  }

  function state(s) {
    if (serverDown) return 'error';
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
      c.dot.className = `dot ${st}`;
      c.chip.classList.toggle('error', st === 'error');
      c.count.textContent = s?.updatedAt ? num(layer.count()) : s?.error || serverDown ? '–' : '…';
      if (serverDown) c.ago.textContent = 'server offline';
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
      c.chip.title = lines.join('\n');
    }
  }

  setInterval(render, 5000);

  return {
    update(statuses) {
      serverDown = false;
      lastStatus = new Map(statuses.map((s) => [s.id, s]));
      render();
    },
    setServerDown() {
      serverDown = true;
      render();
    },
    render,
  };
}
