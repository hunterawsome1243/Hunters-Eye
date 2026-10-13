// Ambient rotation from space: one 1 s camera ease per step, chained on
// moveend, so the map renders only while easing and the cost is bounded.
// Never under prefers-reduced-motion, a hidden tab, a data-saver connection,
// an open detail panel or the aircraft view filter (isBlocked), and only while
// zoomed out past STOP_Z. The user's first gesture stops it; desktops resume
// after RESUME_MS idle, phones stay off until the control is pressed again.
// ?spin=off and localStorage 'he.spin' remember the choice.
export function createSpin(map, { phone = false, isBlocked = () => false } = {}) {
  const DPS = phone ? 1.5 : 2;
  const STOP_Z = 3.5;
  const SLOW_Z = 2.5;
  const STEP = 1000;
  const RESUME_MS = 15000;
  const PHONE_BUDGET = 120_000;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let enabled = readPref();
  let interacting = false;
  let spent = 0;
  let timer = null;
  let spinning = false; // a spin step is the move in progress
  const listeners = new Set();
  const changed = () => listeners.forEach((fn) => fn(enabled));

  function readPref() {
    if (new URLSearchParams(location.search).get('spin') === 'off') return false;
    try {
      return localStorage.getItem('he.spin') !== '0';
    } catch {
      return true;
    }
  }

  function canStep() {
    if (!enabled || interacting || document.hidden || reduce.matches || navigator.connection?.saveData) return false;
    if (isBlocked() || map.isMoving()) return false;
    if (phone && spent >= PHONE_BUDGET) {
      enabled = false; // budget spent: the control shows off, and one press starts it again
      changed();
      return false;
    }
    return map.getZoom() < STOP_Z;
  }

  function step() {
    if (!canStep()) return;
    const z = map.getZoom();
    const dps = z > SLOW_Z ? (DPS * (STOP_Z - z)) / (STOP_Z - SLOW_Z) : DPS;
    const c = map.getCenter();
    c.lng -= (dps * STEP) / 1000;
    spent += STEP;
    spinning = true;
    // essential: under reduced motion the loop never runs, but an ease that
    // became 0 ms would otherwise spin like a strobe.
    map.easeTo({ center: c, duration: STEP, easing: (t) => t, essential: true }, { spin: true });
  }

  function later() {
    clearTimeout(timer);
    if (!phone) timer = setTimeout(step, RESUME_MS);
  }

  map.on('moveend', (e) => {
    spinning = false;
    if (e.spin) step();
    else if (!interacting) later(); // a flyTo or fitBounds ended: pick up again after a while
  });
  for (const ev of ['mousedown', 'touchstart', 'wheel']) {
    map.on(ev, () => {
      interacting = true;
      clearTimeout(timer);
      if (spinning) map.stop(); // only the spin's own ease; MapLibre's handlers stay intact
      if (phone && enabled) {
        enabled = false; // a phone spins again only when its control is pressed
        changed();
      }
    });
  }
  map.getCanvas().addEventListener('keydown', () => {
    interacting = true;
    clearTimeout(timer);
    if (spinning) map.stop();
  });
  map.getCanvas().addEventListener('keyup', () => {
    interacting = false;
    later();
  });
  for (const ev of ['mouseup', 'touchend', 'dragend', 'zoomend', 'pitchend', 'rotateend']) {
    map.on(ev, () => {
      interacting = false;
      later();
    });
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? map.stop() : step()));
  reduce.addEventListener('change', () => (reduce.matches ? map.stop() : step()));
  map.once('idle', step);

  return {
    step,
    // Cancels the next step and the spin's own move, never someone else's flight.
    pause() {
      clearTimeout(timer);
      if (spinning) map.stop();
    },
    resume() {
      if (map.isMoving()) map.once('moveend', step);
      else step();
    },
    get spinning() {
      return spinning;
    },
    onChange(fn) {
      listeners.add(fn);
    },
    set(on) {
      enabled = on;
      changed();
      try {
        localStorage.setItem('he.spin', on ? '1' : '0');
      } catch {
        // private mode: the choice lasts for this page only
      }
      if (on) {
        spent = 0;
        interacting = false;
        step();
      } else {
        clearTimeout(timer);
        map.stop();
      }
    },
    get on() {
      return enabled;
    },
  };
}
