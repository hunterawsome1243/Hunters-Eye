import { el } from './format.js';

// A row of swatches with labels under a filter: [[color, label, kind?], ...].
// shape 'dot' for point markers, 'square' for areas; kind 'ring' marks one row as an outline.
export function legend(items, { shape = 'dot', label } = {}) {
  return el('ul', { class: 'legend', 'data-shape': shape, 'aria-label': label },
    ...items.map(([color, text, kind]) => el('li', {},
      el('i', { class: kind ? `swatch ${kind}` : 'swatch', style: `--c:${color}` }), text)));
}
