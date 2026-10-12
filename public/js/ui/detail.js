import { el } from './format.js';

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
  // Leftover drag styles go too, unless a finger still holds the sheet.
  function settle() {
    if (closing) {
      clearTimeout(closing);
      closing = null;
      root.classList.remove('closing');
    }
    if (!drag) clearDragStyles();
  }
  function finishHide() {
    settle();
    root.hidden = true;
  }
  function hide() {
    if (currentKey === null) return;
    currentKey = null;
    cancelDrag(); // closed from elsewhere mid-drag (an alert expiring, a map tap)
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

  // On phones the panel is a bottom sheet: dragging its header down from the top
  // closes it; dragging up (or down while scrolled) scrolls the sheet instead.
  let drag = null;
  function clearDragStyles() {
    root.style.removeProperty('--drag');
    root.style.transform = '';
    root.style.opacity = '';
    root.style.transition = '';
  }
  function cancelDrag() {
    if (!drag) return;
    try { head.releasePointerCapture(drag.id); } catch { /* never captured */ }
    drag = null;
  }
  head.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !SHEET.matches || currentKey === null || closeBtn.contains(e.target)) return;
    drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, startTop: root.scrollTop, dy: 0, mode: null };
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.startX;
    const raw = e.clientY - drag.startY;
    if (!drag.mode) {
      if (Math.abs(raw) <= 6 || Math.abs(raw) < Math.abs(dx)) return; // not a vertical swipe yet
      drag.mode = raw > 0 && drag.startTop === 0 ? 'dismiss' : 'scroll';
      try { head.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      if (drag.mode === 'dismiss') root.style.transition = 'none';
    }
    if (drag.mode === 'scroll') {
      root.scrollTop = drag.startTop - raw;
      return;
    }
    drag.dy = Math.max(0, raw);
    root.style.transform = `translateY(${drag.dy}px)`;
    root.style.opacity = String(Math.max(0.4, 1 - drag.dy / 320));
  });
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { dy, mode } = drag;
    drag = null;
    if (mode !== 'dismiss') return;
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

  // A field is [label, value, sub?]: the optional sub ("459 kt", "3 min ago") is a
  // muted second line instead of a bracket that wraps mid-value.
  function value(v, sub) {
    return sub ? el('dd', {}, v, el('span', { class: 'sub' }, sub)) : el('dd', {}, v);
  }

  return {
    show({ key, color, kind, heading, fields = [], notes = '', link, latlng = null, radius }) {
      const changed = key !== currentKey;
      settle(); // reopened mid-close: just keep it
      currentKey = key;
      swatch.style.background = color;
      kicker.textContent = kind;
      title.textContent = heading;
      rows.replaceChildren(...fields.filter(([, v]) => v != null && v !== '').flatMap(([k, v, sub]) => [el('dt', {}, k), value(v, sub)]));
      extra.replaceChildren();
      if (notes) extra.append(notes);
      if (link && /^https?:\/\//.test(link.href)) extra.append(notes ? '\n\n' : '', el('a', { href: link.href, target: '_blank', rel: 'noopener' }, link.label));
      root.hidden = false;
      if (changed) {
        root.scrollTop = 0;
        onShow?.({ key, color, latlng, radius });
      }
    },
    hide,
    get key() {
      return currentKey;
    },
  };
}
