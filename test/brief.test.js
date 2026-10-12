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
