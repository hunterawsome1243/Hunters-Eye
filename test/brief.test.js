import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApp } from '../server/app.js';
import { createBriefRoute, createThrottle, estimateCost, sanitizeSnapshot } from '../server/brief.js';

const source = { id: 'earthquakes', name: 'Earthquakes', intervalMs: 60_000, fetch: async () => ({ quakes: [] }) };
async function serve(brief) {
  const { app, pollers } = createApp([source], { autoStart: false }, { brief, imagery: null });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { for (const p of pollers.values()) p.stop(); server.close(); } };
}

test('sanitizeSnapshot keeps only the fields the prompt needs and caps sizes', () => {
  const s = sanitizeSnapshot({
    now: '2026-10-12T18:00:00Z', zoom: 2.123456, view: { lamin: 1, lomin: 2, lamax: 3, lomax: 4 },
    layers: [{ id: 'earthquakes', name: 'Earthquakes', visible: true, count: 12, extra: 'x' }],
    feeds: [{ id: 'aircraft', state: 'error', detail: 'y'.repeat(500) }],
    events: Array.from({ length: 100 }, (_, i) => ({ source: 'earthquakes', time: 't', title: `q${i}`, subtitle: 's', secret: 1 })),
  });
  assert.equal(s.events.length, 40);
  assert.equal(s.feeds[0].detail.length, 160);
  assert.deepEqual(Object.keys(s.layers[0]), ['id', 'name', 'visible', 'count']);
  assert.deepEqual(s.view, { south: 1, west: 2, north: 3, east: 4 });
  assert.equal(s.zoom, 2.123);
  assert.throws(() => sanitizeSnapshot('nope'));
});

test('estimateCost prices Haiku 5.5 usage', () => {
  assert.equal(estimateCost('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 0.6);
  assert.equal(estimateCost('other', { input_tokens: 1 }), null);
});

test('the throttle enforces a gap and an hourly cap', () => {
  let t = 0;
  const th = createThrottle({ minGapMs: 1000, perHour: 2, now: () => t });
  assert.ok(th.take().ok);
  assert.equal(th.take().ok, false);
  t = 1000;
  assert.ok(th.take().ok);
  t = 2000;
  assert.match(th.take().reason, /hourly limit/);
  t = 3_601_000;
  assert.ok(th.take().ok);
});

test('the throttle names what it limits and keeps a share of the hour for other addresses', () => {
  let t = 0;
  const th = createThrottle({ minGapMs: 1000, perHour: 4, noun: 'description', now: () => t });
  assert.equal(th.take('a').ok, true);
  assert.equal(th.take('b').reason, 'A description was just written; try again in a few seconds.');
  for (const at of [1000, 2000]) {
    t = at;
    assert.equal(th.take('a').ok, true);
  }
  t = 2500; // inside the gap too, but the share is what is really in the way
  const mine = th.take('a'); // three of the hour's four is one address's share
  assert.equal(mine.ok, false);
  assert.equal(mine.reason, 'Your connection has had its 3 descriptions for this hour (everyone on the same network shares them). Try again in 60 min.');
  t = 3000;
  assert.equal(th.take('b').ok, true); // someone else still can
  t = 4000;
  assert.equal(th.take('c').reason, 'The hourly limit of 4 descriptions is used up. Try again in 60 min.');
  t = 3_600_500; // a's first press has aged out
  assert.equal(th.take('a').ok, true);
});

test('when both hourly limits are in the way, the throttle names the longer wait', () => {
  const MIN = 60_000;
  let t = 0;
  const th = createThrottle({ minGapMs: 0, perHour: 20, now: () => t }); // 15 per address
  for (const who of ['b', 'b', 'b', 'b', 'b']) assert.equal(th.take(who).ok, true);
  for (let i = 0; i < 15; i++) {
    t = 30 * MIN + i;
    assert.equal(th.take('a').ok, true);
  }
  t = 45 * MIN; // the hour's 20 are used: b's free up at minute 60, a's own share only at 90
  assert.match(th.take('a').reason, /^Your connection has had its 15 briefs .* Try again in 45 min\.$/);
  assert.match(th.take('c').reason, /^The hourly limit of 20 briefs is used up\. Try again in 15 min\.$/);
});

test('a refusal never asks for less time than the gap still needs', () => {
  const H = 3_600_000;
  let t = 0;
  const th = createThrottle({ minGapMs: 5000, perHour: 2, perAddress: 2, now: () => t });
  assert.equal(th.take('a').ok, true);
  t = H - 2000;
  assert.equal(th.take('b').ok, true);
  t = H - 1000; // the hour frees a slot in 1 s, but the gap needs 4 s more
  assert.equal(th.take('c').retryAfterMs, 4000);
  t = 0;
  const th2 = createThrottle({ minGapMs: 5000, perHour: 20, perAddress: 2, now: () => t });
  assert.equal(th2.take('a').ok, true);
  t = H - 2000;
  assert.equal(th2.take('a').ok, true);
  t = H - 1000; // the address frees a slot in 1 s, the gap needs 4 s
  const mine = th2.take('a');
  assert.match(mine.reason, /^Your connection has had its 2 briefs/);
  assert.equal(mine.retryAfterMs, 4000);
});

test('without a key the route is off and config says so', async () => {
  const { base, close } = await serve(createBriefRoute({ apiKey: '' }));
  try {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.brief, null);
    const res = await fetch(`${base}/api/brief`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 404);
  } finally {
    close();
  }
});

test('with a key the route asks Claude once per press and reports the cost', async () => {
  const calls = [];
  const ask = async (snapshot) => {
    calls.push(snapshot);
    return { text: 'Quiet night. One M5 off Japan an hour ago.', usage: { input_tokens: 1200, output_tokens: 60 } };
  };
  const { base, close } = await serve(createBriefRoute({ apiKey: 'sk-test', ask, throttle: createThrottle({ minGapMs: 0, perHour: 100 }) }));
  try {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(config.brief, { model: 'claude-haiku-5-5' });
    const res = await fetch(`${base}/api/brief`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layers: [{ id: 'earthquakes', name: 'Earthquakes', visible: true, count: 1 }], events: [] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.text, /Japan/);
    assert.ok(Math.abs(body.costUsd - 0.00015) < 1e-9);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].layers[0].count, 1);
  } finally {
    close();
  }
});

test('API failures become a clear error, and the gap throttle answers 429', async () => {
  const ask = async () => { const e = new Error('invalid x-api-key'); e.status = 401; throw e; };
  const { base, close } = await serve(createBriefRoute({ apiKey: 'sk-test', ask, throttle: createThrottle({ minGapMs: 60_000, perHour: 100 }) }));
  try {
    const first = await fetch(`${base}/api/brief`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(first.status, 502);
    assert.match((await first.json()).error, /rejected/);
    const second = await fetch(`${base}/api/brief`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(second.status, 429);
    assert.ok(second.headers.get('retry-after'));
  } finally {
    close();
  }
});
