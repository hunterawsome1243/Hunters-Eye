import { el, num } from './format.js';
import { distanceKm } from '../globe/geo.js';

// Watchlist: a few rules the reader cares about, checked against every feed entry
// that lands after the first load. A rule is a keyword (a callsign, a place, an
// alert type, "M6"), a distance from the "you are here" marker, or both. A hit
// marks the row in the feed and, when the browser allows it, shows a notification.
// Rules live in localStorage; nothing leaves the browser.
const KEY = 'he.watch';
const MAX_RULES = 12;

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

// Pure, so test/watch.test.js can exercise it: does this entry trip this rule?
// `here` is the marker position ({ lat, lon }) or null; a distance rule without one never fires.
export function matches(rule, entry, here = null) {
  if (!rule || entry.system) return false;
  const keyword = (rule.keyword ?? '').trim().toLowerCase();
  const km = Number(rule.km);
  if (!keyword && !(km > 0)) return false;
  if (keyword) {
    const text = `${entry.title ?? ''} ${entry.subtitle ?? ''}`.toLowerCase();
    if (!text.includes(keyword)) return false;
  }
  if (km > 0) {
    if (!here || !entry.latlng) return false;
    if (distanceKm([here.lat, here.lon], entry.latlng) > km) return false;
  }
  return true;
}

export function describeRule(rule) {
  const parts = [];
  if (rule.keyword) parts.push(`“${rule.keyword}”`);
  if (rule.km > 0) parts.push(`within ${num(rule.km)} km of you`);
  return parts.join(' ');
}

export function createWatch(root, { here = () => null, onHit = () => {}, notifier = globalThis.Notification } = {}) {
  let rules = [];
  try {
    const saved = JSON.parse(storage()?.getItem(KEY) ?? '[]');
    if (Array.isArray(saved)) rules = saved.filter((r) => r && (r.keyword || r.km > 0)).slice(0, MAX_RULES).map((r) => ({ keyword: String(r.keyword ?? ''), km: Number(r.km) || 0, hits: 0 }));
  } catch { /* bad JSON */ }
  const save = () => {
    try {
      storage()?.setItem(KEY, JSON.stringify(rules.map(({ keyword, km }) => ({ keyword, km }))));
    } catch { /* private mode or full */ }
  };

  const keyword = el('input', { type: 'text', class: 'watch-keyword', placeholder: 'Callsign, place, alert type, M6…', maxlength: '60', 'aria-label': 'Keyword to watch for' });
  const km = el('input', { type: 'number', class: 'watch-km', placeholder: 'km', min: '1', max: '20000', step: '1', 'aria-label': 'Within this many km of you' });
  const add = el('button', { type: 'submit', class: 'brief-btn watch-add' }, 'Watch');
  const form = el('form', { class: 'watch-form' }, keyword, el('label', { class: 'watch-km-label' }, 'within', km, 'km of you'), add);
  const list = el('ul', { class: 'watch-list' });
  const hint = el('div', { class: 'watch-hint muted' });
  // Folds like the filters so the feed keeps its height; the rule count stays in the heading.
  const count = el('span', { class: 'muted watch-count' });
  const toggle = el('button', { type: 'button', class: 'section-toggle', 'aria-expanded': 'false', 'aria-controls': 'watch-panel' },
    el('span', {}, 'Watchlist ', count),
    el('span', { class: 'chevron', 'aria-hidden': 'true' }));
  toggle.querySelector('.chevron').innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const body = el('div', { id: 'watch-panel', class: 'collapse' }, el('div', { class: 'collapse-body' }, form, list, hint));
  root.append(el('h2', {}, toggle), body);
  let open = false;
  try { open = storage()?.getItem(`${KEY}.open`) === '1'; } catch { /* closed */ }
  function setOpen(on) {
    open = on;
    root.classList.toggle('open', on);
    toggle.setAttribute('aria-expanded', String(on));
    body.querySelector('.collapse-body').inert = !on;
    try { storage()?.setItem(`${KEY}.open`, on ? '1' : '0'); } catch { /* fine */ }
  }
  toggle.addEventListener('click', () => setOpen(!open));
  root.classList.add('no-anim');
  setOpen(open);
  requestAnimationFrame(() => root.classList.remove('no-anim'));

  const permission = () => (notifier ? notifier.permission : 'unsupported');
  function renderHint() {
    const p = permission();
    const base = rules.length ? '' : 'Get told when something you care about lands: a callsign, a county, "Tornado", "M6", or anything within a distance of you. ';
    const note = p === 'granted' ? 'Hits show in the feed and as a notification.'
      : p === 'denied' ? 'Notifications are blocked in this browser; hits still show in the feed.'
      : p === 'unsupported' ? 'Hits show in the feed.'
      : 'Hits show in the feed; adding a rule asks to show notifications too.';
    hint.textContent = base + note;
    const you = here();
    km.disabled = !you;
    km.title = you ? '' : 'Press the crosshair button on the globe first, so there is a "you" to measure from.';
  }
  function render() {
    list.replaceChildren(...rules.map((rule, i) => el('li', { class: 'watch-rule' },
      el('span', { class: 'watch-text' }, describeRule(rule)),
      rule.hits ? el('span', { class: 'watch-hits', title: 'Hits since this page opened' }, num(rule.hits)) : null,
      el('button', { type: 'button', class: 'icon-btn watch-remove', 'aria-label': `Stop watching ${describeRule(rule)}`, onclick: () => { rules.splice(i, 1); save(); render(); } }, '×'),
    )));
    renderHint();
    count.textContent = rules.length ? `(${rules.length})` : '';
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const rule = { keyword: keyword.value.trim(), km: km.disabled ? 0 : Number(km.value) || 0, hits: 0 };
    if (!rule.keyword && !(rule.km > 0)) return;
    if (rules.length >= MAX_RULES) rules.shift();
    rules.push(rule);
    keyword.value = '';
    km.value = '';
    save();
    render();
    if (notifier && notifier.permission === 'default') notifier.requestPermission().then(renderHint).catch(() => {});
  });

  function notify(entry, rule) {
    if (!notifier || notifier.permission !== 'granted' || document.visibilityState === 'visible') return;
    try {
      const n = new notifier(entry.title, { body: `${entry.subtitle ? `${entry.subtitle} · ` : ''}watching ${describeRule(rule)}`, tag: entry.id, silent: false });
      n.onclick = () => { window.focus(); entry.onClick?.(); n.close(); };
    } catch { /* a browser that needs a service worker for this */ }
  }

  render();
  return {
    // feed.js calls this for every entry that lands after the first load.
    check(entry) {
      const you = here();
      const rule = rules.find((r) => matches(r, entry, you));
      if (!rule) return false;
      rule.hits += 1;
      entry.watched = true;
      render();
      notify(entry, rule);
      onHit(entry, rule);
      return true;
    },
    rules: () => rules.map(({ keyword, km }) => ({ keyword, km })),
    refresh: renderHint,
  };
}
