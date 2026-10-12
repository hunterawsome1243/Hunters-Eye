import { num } from './format.js';

const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)');
const shown = new WeakMap(); // el -> { value: what is on screen now, frame }

// A count ticks from what it shows to its new value instead of jumping (ease out,
// 400ms). The first value counts up from zero; reduced motion sets it outright.
export function tweenNumber(el, to, { duration = 400, format = (v) => num(v) } = {}) {
  const s = shown.get(el) || { value: null, frame: 0 };
  shown.set(el, s);
  cancelAnimationFrame(s.frame);
  const from = s.value ?? 0;
  if (REDUCE.matches || from === to || !Number.isFinite(to)) {
    s.value = to;
    el.textContent = format(to);
    return;
  }
  let start = null; // the first frame's own timestamp, which can precede this call
  const step = (t) => {
    start ??= t;
    const p = Math.min(1, Math.max(0, (t - start) / duration));
    s.value = p < 1 ? Math.round(from + (to - from) * (1 - (1 - p) ** 3)) : to;
    el.textContent = format(s.value);
    if (p < 1) s.frame = requestAnimationFrame(step);
  };
  s.frame = requestAnimationFrame(step);
}

// Plain text in a counter (an ellipsis, a dash): the next number counts up from zero again.
export function setText(el, text) {
  const s = shown.get(el);
  if (s) cancelAnimationFrame(s.frame);
  shown.delete(el);
  el.textContent = text;
}
