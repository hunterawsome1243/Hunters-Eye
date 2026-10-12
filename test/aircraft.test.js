import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creditCost, delayFor, normalizeBbox, normalizeStates } from '../server/sources/aircraft.js';

test('credit cost follows OpenSky area tiers', () => {
  assert.equal(creditCost(null), 4);
  assert.equal(creditCost({ lamin: 0, lamax: 5, lomin: 0, lomax: 5 }), 1);
  assert.equal(creditCost({ lamin: 0, lamax: 10, lomin: 0, lomax: 10 }), 2);
  assert.equal(creditCost({ lamin: 0, lamax: 20, lomin: 0, lomax: 20 }), 3);
  assert.equal(creditCost({ lamin: 0, lamax: 30, lomin: 0, lomax: 30 }), 4);
});

test('refresh delays keep a full day of polling inside the daily credits', () => {
  for (const credits of [400, 4000]) {
    for (const box of [null, { lamin: 0, lamax: 5, lomin: 0, lomax: 5 }]) {
      const requestsPerDay = 86_400_000 / delayFor(box, credits);
      assert.ok(requestsPerDay * creditCost(box) <= credits, `${credits} credits, cost ${creditCost(box)}`);
    }
  }
  assert.ok(delayFor(null, 400) > 15 * 60_000, 'anonymous global refresh is slower than 15 min');
  assert.ok(delayFor(null, 4000) < 2 * 60_000, 'authenticated global refresh is under 2 min');
});

test('bbox is padded, wrapped, and falls back to global when it saves nothing', () => {
  const b = normalizeBbox({ lamin: 45, lomin: 5, lamax: 47, lomax: 10 });
  assert.ok(b.lamin < 45 && b.lomax > 10);
  assert.equal(creditCost(b), 1);
  const wrapped = normalizeBbox({ lamin: 40, lomin: 365, lamax: 42, lomax: 368 });
  assert.ok(wrapped.lomin > 0 && wrapped.lomin < 10);
  assert.equal(normalizeBbox({ lamin: 40, lomin: 170, lamax: 50, lomax: 190 }), null, 'crosses antimeridian');
  assert.equal(normalizeBbox({ lamin: -60, lomin: -120, lamax: 60, lomax: 60 }), null, 'too large');
  assert.equal(normalizeBbox(null), null);
  assert.throws(() => normalizeBbox({ lamin: 'x' }));
});

test('state vectors become compact rows and drop ones with no position', () => {
  const out = normalizeStates({
    time: 1700000000,
    states: [
      ['abc123', 'DLH4AB  ', 'Germany', 1699999995, 1699999999, 8.5, 50.1, 10500, false, 230.5, 87.2, 0, null, 10700, '1000', false, 0, 6],
      ['def456', '', 'France', null, 1699999999, null, null, null, true, 0, 0, null, null, null, null, false, 0, 0],
    ],
  });
  assert.equal(out.time, 1700000000000);
  assert.equal(out.states.length, 1);
  const row = Object.fromEntries(out.fields.map((f, i) => [f, out.states[0][i]]));
  assert.equal(row.callsign, 'DLH4AB');
  assert.equal(row.altitude, 10500);
  assert.equal(row.track, 87.2);
  assert.equal(row.category, 6);
  assert.equal(row.timePosition, 1699999995);
});
