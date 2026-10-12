import { el, num, timeAgo } from './format.js';

// "Brief me": one button that asks the server for a Claude-written summary of
// what the dashboard shows right now. The section stays hidden unless
// /api/config says the server has a key. Nothing is sent until the button is
// pressed, and each press is one request.
export function createBrief(root, { snapshot, fetchImpl = fetch } = {}) {
  const button = el('button', { type: 'button', class: 'brief-btn' }, 'Brief me');
  const meta = el('div', { class: 'brief-meta muted' });
  const output = el('p', { class: 'brief-text' });
  const body = el('div', { class: 'brief-body', role: 'status', 'aria-live': 'polite' }, output, meta);
  root.append(
    el('h2', {}, 'Situation brief ', el('span', { class: 'muted' }, 'by Claude')),
    el('div', { class: 'brief-row' }, button, el('span', { class: 'brief-hint muted' }, 'A short read of what is on the globe right now. About a thirtieth of a cent per press.')),
    body,
  );
  root.hidden = true;
  let busy = false;

  async function run() {
    if (busy) return;
    busy = true;
    button.setAttribute('aria-busy', 'true'); // stays enabled so keyboard focus is kept
    button.textContent = 'Writing…';
    output.classList.remove('error');
    try {
      const res = await fetchImpl('/api/brief', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot()),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      output.textContent = data.text;
      const cost = data.costUsd != null ? ` · cost ${data.costUsd < 0.001 ? '<0.1¢' : `${num(data.costUsd * 100, 1)}¢`}` : ' · cost not known for this model';
      meta.textContent = `${data.model || 'Claude'} · ${timeAgo(data.at)}${cost}`;
    } catch (err) {
      output.textContent = err.message;
      output.classList.add('error');
      meta.textContent = '';
    } finally {
      busy = false;
      button.removeAttribute('aria-busy');
      button.textContent = 'Brief me';
    }
  }
  button.addEventListener('click', run);

  return {
    // Called once /api/config is in: shows the section when the server can write briefs.
    configure(config) {
      root.hidden = !config;
      if (config?.model) meta.textContent = `Written by ${config.model} when you press the button.`;
    },
    run,
  };
}
