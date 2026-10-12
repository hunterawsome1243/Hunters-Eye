import { el } from './format.js';

// The floating panel that shows whatever item was clicked last.
// A layer calls show() with a key; calling show() again with the same key refreshes
// it in place (used for moving things like aircraft and satellites).
export function createDetailPanel(root, { onClose } = {}) {
  const swatch = root.querySelector('.detail-swatch');
  const kicker = root.querySelector('.detail-kicker');
  const title = root.querySelector('.detail-title');
  const rows = root.querySelector('.detail-rows');
  const extra = root.querySelector('.detail-extra');
  let currentKey = null;

  function hide() {
    if (currentKey === null) return;
    currentKey = null;
    root.hidden = true;
    onClose?.();
  }

  root.querySelector('.detail-close').addEventListener('click', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });

  return {
    show({ key, color, kind, heading, fields = [], notes = '', link }) {
      currentKey = key;
      swatch.style.background = color;
      kicker.textContent = kind;
      title.textContent = heading;
      rows.replaceChildren(...fields.filter(([, v]) => v != null && v !== '').flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
      extra.replaceChildren();
      if (notes) extra.append(notes);
      if (link) extra.append(notes ? '\n\n' : '', el('a', { href: link.href, target: '_blank', rel: 'noopener' }, link.label));
      root.hidden = false;
    },
    hide,
    get key() {
      return currentKey;
    },
  };
}
