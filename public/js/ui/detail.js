import { el } from './format.js';

// Values like "12:04:05 (3 min ago)" or "850 km/h (459 kt)" get the bracketed part
// as a muted second line instead of wrapping mid-value.
const SUB = /^(.+?) \(([^()]+)\)$/;
const SHEET = window.matchMedia('(max-width: 760px), (max-height: 500px)');

// The floating panel that shows whatever item was clicked last.
// A layer calls show() with a key; calling show() again with the same key refreshes
// it in place (used for moving things like aircraft and satellites). onShow fires
// only when the key changes, onClose when the panel goes away.
export function createDetailPanel(root, { onClose, onShow } = {}) {
  const head = root.querySelector('.detail-head');
  const closeBtn = root.querySelector('.detail-close');
  const swatch = root.querySelector('.detail-swatch');
  const kicker = root.querySelector('.detail-kicker');
  const title = root.querySelector('.detail-title');
  const rows = root.querySelector('.detail-rows');
  const extra = root.querySelector('.detail-extra');
  let currentKey = null;
  let closing = null; // fallback timer while the exit animation plays

  // The panel stays in the DOM while its exit animation runs, then hides for real.
  function settle() {
    if (!closing) return;
    clearTimeout(closing);
    closing = null;
    root.classList.remove('closing');
    root.style.removeProperty('--drag');
    root.style.transform = '';
    root.style.opacity = '';
  }
  function finishHide() {
    settle();
    root.hidden = true;
  }
  function hide() {
    if (currentKey === null) return;
    currentKey = null;
    root.classList.add('closing');
    closing = setTimeout(finishHide, 400);
    onClose?.();
  }
  root.addEventListener('animationend', (e) => {
    if (e.target === root && closing) finishHide();
  });

  closeBtn.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });

  // On phones the panel is a bottom sheet: dragging its header down closes it.
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !SHEET.matches || closeBtn.contains(e.target)) return;
    drag = { id: e.pointerId, startY: e.clientY, dy: 0, moving: false };
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.startY);
    if (!drag.moving && drag.dy > 6) {
      drag.moving = true;
      try { head.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      root.style.transition = 'none';
    }
    if (!drag.moving) return;
    root.style.transform = `translateY(${drag.dy}px)`;
    root.style.opacity = String(Math.max(0.4, 1 - drag.dy / 320));
  });
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { dy, moving } = drag;
    drag = null;
    if (!moving) return;
    root.style.transition = '';
    if (dy > 72) {
      // The exit animation carries on from where the finger left it: the inline
      // transform and opacity stay until settle() clears them.
      root.style.setProperty('--drag', `${dy}px`);
      hide();
    } else {
      root.classList.add('snap');
      root.style.transform = '';
      root.style.opacity = '';
      setTimeout(() => root.classList.remove('snap'), 200);
    }
  }
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  function value(v) {
    const m = typeof v === 'string' && SUB.exec(v);
    return m ? el('dd', {}, m[1], el('span', { class: 'sub' }, m[2])) : el('dd', {}, v);
  }

  return {
    show({ key, color, kind, heading, fields = [], notes = '', link, latlng = null }) {
      const changed = key !== currentKey;
      settle(); // reopened mid-close: just keep it
      currentKey = key;
      swatch.style.background = color;
      kicker.textContent = kind;
      title.textContent = heading;
      rows.replaceChildren(...fields.filter(([, v]) => v != null && v !== '').flatMap(([k, v]) => [el('dt', {}, k), value(v)]));
      extra.replaceChildren();
      if (notes) extra.append(notes);
      if (link && /^https?:\/\//.test(link.href)) extra.append(notes ? '\n\n' : '', el('a', { href: link.href, target: '_blank', rel: 'noopener' }, link.label));
      root.hidden = false;
      if (changed) {
        root.scrollTop = 0;
        onShow?.({ key, color, latlng });
      }
    },
    hide,
    get key() {
      return currentKey;
    },
  };
}
