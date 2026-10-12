import { el } from './format.js';

// A row of swatches with labels under a filter: [[color, label], ...].
// shape 'dot' for point markers, 'square' for areas.
export function legend(items, { shape = 'dot', label } = {}) {
  return el('ul', { class: 'legend', 'data-shape': shape, 'aria-label': label },
    ...items.map(([color, text]) => el('li', {}, el('i', { class: 'swatch', style: `--c:${color}` }), text)));
}
