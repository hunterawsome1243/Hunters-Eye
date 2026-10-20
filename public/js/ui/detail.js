import { el, num, timeAgo, OFFLINE } from './format.js';
import { bearingDeg, compassPoint, distanceKm } from '../globe/geo.js';
import { PLANE_PATH } from '../globe/icons.js';

const SHEET = window.matchMedia('(max-width: 760px), (max-height: 500px)');

// The header icon, by the layer named in the key ("aircraft:abc123"), drawn in the item's
// own colour (age, altitude, severity). Static markup only.
const svg = (body, box = '0 0 16 16') => `<svg viewBox="${box}">${body}</svg>`;
const ICONS = {
  earthquakes: svg('<circle cx="8" cy="8" r="2.75" fill="currentColor"/><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/>'),
  aircraft: svg(`<path d="${PLANE_PATH}" fill="currentColor"/>`, '-8 -8 16 16'),
  satellites: svg('<g fill="currentColor" transform="rotate(-35 8 8)"><rect x="6" y="5.25" width="4" height="5.5" rx="0.75"/><rect x="0.5" y="6" width="4.25" height="4" rx="0.5"/><rect x="11.25" y="6" width="4.25" height="4" rx="0.5"/><rect x="4" y="7.6" width="8" height="0.8"/></g>'),
  weather: svg('<path fill="currentColor" fill-rule="evenodd" d="M8 1.2 15.2 14.3H.8Z M7.1 5.6h1.8l-.35 4.7h-1.1Z M7.1 11.3h1.8v1.6H7.1Z"/>'),
};
const SQUARE = svg('<rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor"/>');

// The floating panel that shows whatever item was clicked last.
// A layer calls show() with a key; calling show() again with the same key refreshes
// it in place (used for moving things like aircraft and satellites). onShow fires
// only when the key changes, onClose when the panel goes away. familyColor(key) gives the
// layer's own colour for the kicker. Closing it with focus inside puts focus back where
// it came from, else on the first of focusAfter() that takes it (the feed row, the globe).
export function createDetailPanel(root, { onClose, onShow, here = () => null, familyColor = () => null, focusAfter = () => [], fetchImpl = fetch } = {}) {
  const head = root.querySelector('.detail-head');
  const closeBtn = root.querySelector('.detail-close');
  const icon = root.querySelector('.detail-icon');
  const kicker = root.querySelector('.detail-kicker');
  const title = root.querySelector('.detail-title');
  const rows = root.querySelector('.detail-rows');
  const extra = root.querySelector('.detail-extra');
  // Long notes (an NWS alert's full text) fold at six lines behind "Show more"; the
  // choice holds while the same item refreshes, and resets for the next one.
  const notesEl = el('p', { class: 'detail-notes', id: 'detail-notes' });
  const moreBtn = el('button', { type: 'button', class: 'detail-more', 'aria-controls': 'detail-notes', 'aria-expanded': 'false' }, 'Show more');
  const linkEl = el('p', { class: 'detail-link' });
  // The card is not a live region (a satellite's card refreshes every second); a screen
  // reader hears one line here when a new item opens.
  const say = el('div', { class: 'sr-only', role: 'status' });
  root.after(say);
  // The same line twice (a second "Flood Warning", a reopen) may go unspoken, so it is
  // cleared and written again a moment later.
  function announce(line, key) {
    if (say.textContent !== line) { say.textContent = line; return; }
    say.textContent = '';
    setTimeout(() => { if (currentKey === key) say.textContent = line; }, 100);
  }
  let shownLabels = null; // the rows on show, so a refresh can patch values in place
  let opener = null; // what had focus when the card opened
  let notesOpen = false;
  let shownNotes = null;
  let shownLayer = null;
  function fitNotes() {
    notesEl.classList.add('clamped');
    const overflows = notesEl.scrollHeight > notesEl.clientHeight + 1;
    notesEl.classList.toggle('clamped', overflows && !notesOpen);
    moreBtn.hidden = !overflows;
    moreBtn.textContent = notesOpen ? 'Show less' : 'Show more';
    moreBtn.setAttribute('aria-expanded', String(notesOpen));
  }
  moreBtn.addEventListener('click', () => {
    notesOpen = !notesOpen;
    fitNotes();
  });
  let currentKey = null;
  let currentItem = null; // what show() was last given, for the Describe button
  let closing = null; // fallback timer while the exit animation plays

  // "Describe": one button that asks the server for a Claude-written description of
  // the shown object. Hidden until /api/config says the server has a key. Nothing is
  // sent until the button is pressed; a new object clears the last description.
  const describeBtn = el('button', { type: 'button', class: 'brief-btn describe-btn' }, 'Describe');
  const describeText = el('p', { class: 'describe-text' });
  // A failed press or follow-up says why on its own line, just above the follow-up
  // box, and leaves the description and the answers so far in place.
  const describeErr = el('p', { class: 'describe-text error' });
  describeErr.hidden = true;
  const describeMeta = el('div', { class: 'describe-meta muted' });
  // After a description, a one-line form asks a follow-up about the same object; the
  // answer lands under the question. Only the last answer goes back with the question.
  const thread = el('div', { class: 'describe-thread' });
  const askInput = el('input', { type: 'text', class: 'describe-ask', placeholder: 'Ask a follow-up…', maxlength: '300', 'aria-label': 'Ask a follow-up question about this object' });
  const askBtn = el('button', { type: 'submit', class: 'brief-btn describe-ask-btn' }, 'Ask');
  const askForm = el('form', { class: 'describe-ask-row' }, askInput, askBtn);
  askForm.hidden = true;
  const describe = el('div', { class: 'detail-describe', role: 'status', 'aria-live': 'polite' },
    el('div', { class: 'describe-row' }, describeBtn, el('span', { class: 'describe-hint muted' }, 'What this is and why it matters, by Claude.')),
    describeText, thread, describeMeta, describeErr, askForm);
  describe.hidden = true;
  root.append(describe);
  let describing = false;
  let describedKey = null;
  let lastAnswer = null;
  function resetDescribe() {
    describedKey = null;
    lastAnswer = null;
    describeText.textContent = '';
    describeErr.hidden = true;
    describeMeta.textContent = '';
    thread.replaceChildren();
    askForm.hidden = true;
    askInput.value = '';
  }
  // Both the Describe button and the follow-up form go through here; `question` makes
  // it a follow-up carrying the last answer.
  async function runDescribe({ question = null } = {}) {
    if (describing || !currentItem) return;
    describing = true;
    const key = currentKey;
    const busyBtn = question ? askBtn : describeBtn;
    busyBtn.setAttribute('aria-busy', 'true'); // stays enabled so keyboard focus is kept
    busyBtn.textContent = question ? '…' : 'Writing…';
    describeErr.hidden = true;
    const q = question ? el('p', { class: 'describe-q' }, question) : null;
    if (q) thread.append(q);
    try {
      const { kind, heading, fields, notes, link } = currentItem;
      const res = await fetchImpl('/api/describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind, heading, notes: notes || null, link: link?.href ?? null,
          fields: fields.filter(([, v]) => v != null && v !== '').map(([label, value, sub]) => ({ label, value: String(value), sub: sub ?? null })),
          question, previous: question ? lastAnswer : null,
        }),
      }).catch(() => { throw new Error(OFFLINE); });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (key !== currentKey) return; // the user has moved on; don't describe the wrong thing
      describedKey = key;
      lastAnswer = data.text;
      if (question) thread.append(el('p', { class: 'describe-a' }, data.text));
      else describeText.textContent = data.text;
      const cost = data.costUsd != null ? ` · cost ${data.costUsd < 0.001 ? '<0.1¢' : `${num(data.costUsd * 100, 1)}¢`}` : '';
      describeMeta.textContent = `${data.model || 'Claude'} · ${timeAgo(data.at)}${cost}`;
      askForm.hidden = false;
      askInput.value = '';
    } catch (err) {
      if (key !== currentKey) return;
      q?.remove();
      if (question) askInput.value = question; // keep the question so it can be sent again
      describeErr.textContent = err.message;
      describeErr.hidden = false;
    } finally {
      describing = false;
      busyBtn.removeAttribute('aria-busy');
      busyBtn.textContent = question ? 'Ask' : 'Describe';
    }
  }
  describeBtn.addEventListener('click', () => runDescribe());
  askForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = askInput.value.trim();
    if (question) runDescribe({ question });
  });

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
  // Focus left inside the closing card would sit on a hidden element, and the next Tab
  // would start again at the top of the page.
  function returnFocus() {
    for (const node of [opener, ...focusAfter()]) {
      if (!node?.isConnected || root.contains(node)) continue;
      node.focus({ preventScroll: true });
      if (document.activeElement === node) return;
    }
  }
  function hide() {
    if (currentKey === null) return;
    currentKey = null;
    currentItem = null;
    resetDescribe();
    cancelDrag(); // closed from elsewhere mid-drag (an alert expiring, a map tap)
    if (root.contains(document.activeElement)) returnFocus();
    opener = null;
    say.textContent = ''; // a closed card leaves no line behind for browse mode
    root.classList.add('closing');
    closing = setTimeout(finishHide, 400);
    onClose?.();
  }
  root.addEventListener('animationend', (e) => {
    if (e.target === root && closing) finishHide();
  });

  closeBtn.addEventListener('click', hide);
  // Escape typed in a text field is the field's (it would otherwise throw away a
  // half-typed follow-up and the description above it).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest?.('input[type=text], input[type=number], textarea')) hide();
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
      if (changed && !root.contains(document.activeElement)) opener = document.activeElement;
      settle(); // reopened mid-close: just keep it
      currentKey = key;
      currentItem = { kind, heading, fields, notes, link };
      if (changed && describedKey !== key) resetDescribe();
      const layer = key.split(':')[0];
      if (layer !== shownLayer) {
        icon.innerHTML = ICONS[layer] ?? SQUARE;
        shownLayer = layer;
      }
      icon.style.color = color;
      kicker.style.color = familyColor(key) || '';
      if (kicker.textContent !== kind) kicker.textContent = kind;
      if (title.textContent !== heading) title.textContent = heading;
      // With a "you are here" marker set, the last row says how far away this is.
      const you = latlng ? here() : null;
      const shownFields = you
        ? [...fields, ['From you', `${num(distanceKm([you.lat, you.lon], latlng))} km`, `to the ${compassPoint(bearingDeg([you.lat, you.lon], latlng))} of ${you.place ? you.place.split(',')[0] : 'you'}`]]
        : fields;
      // The same rows again (a moving item's refresh) get only their changed values
      // replaced, so selecting and copying a row survives the next tick.
      const pairs = shownFields.filter(([, v]) => v != null && v !== '');
      const labels = pairs.map(([k]) => k).join('\n');
      if (changed || labels !== shownLabels) {
        shownLabels = labels;
        rows.replaceChildren(...pairs.flatMap(([k, v, sub]) => [el('dt', {}, k), value(v, sub)]));
      } else {
        pairs.forEach(([, v, sub], i) => {
          const dd = rows.children[2 * i + 1];
          const next = value(v, sub);
          if (!dd.isEqualNode(next)) dd.replaceWith(next);
        });
      }
      if (changed) notesOpen = false;
      // Rebuilt only when something changed, so a refresh never drops keyboard focus.
      const linked = link && /^https?:\/\//.test(link.href);
      const a = linkEl.firstElementChild;
      if (linked && (a?.getAttribute('href') !== link.href || a.textContent !== link.label)) {
        linkEl.replaceChildren(el('a', { href: link.href, target: '_blank', rel: 'noopener' }, link.label));
      }
      const parts = [...(notes ? [notesEl, moreBtn] : []), ...(linked ? [linkEl] : [])];
      if (parts.length !== extra.children.length || parts.some((n, i) => extra.children[i] !== n)) extra.replaceChildren(...parts);
      root.hidden = false;
      // Measured once the card is on screen, and again only when the text changes.
      if (notes && (changed || notes !== shownNotes)) {
        notesEl.textContent = notes;
        fitNotes();
      }
      shownNotes = notes || null;
      if (changed) {
        root.scrollTop = 0;
        announce(`${kind}: ${heading}`, key);
        onShow?.({ key, color, latlng, radius });
      }
    },
    hide,
    get key() {
      return currentKey;
    },
    // Called once /api/config is in: shows the Describe button when the server can write descriptions.
    configure(config) {
      describe.hidden = !config;
    },
    describe: () => runDescribe(),
  };
}
