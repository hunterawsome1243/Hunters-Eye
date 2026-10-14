import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createThrottle } from '../server/brief.js';
import { createDescribeRoute, sanitizeItem } from '../server/describe.js';

const source = { id: 'earthquakes', name: 'Earthquakes', intervalMs: 60_000, fetch: async () => ({ quakes: [] }) };
async function serve(describe) {
  const { app, pollers } = createApp([source], { autoStart: false }, { describe, imagery: null });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { for (const p of pollers.values()) p.stop(); server.close(); } };
}
const post = (base, body) => fetch(`${base}/api/describe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('sanitizeItem keeps the card fields, drops empties and caps sizes', () => {
  const item = sanitizeItem({
    kind: 'Aircraft', heading: 'UAL123', notes: 'n'.repeat(400), link: 'https://example.com', secret: 'x',
    fields: [
      { label: 'Callsign', value: 'UAL123', sub: null, extra: 1 },
      { label: 'Altitude', value: 11000, sub: '36,089 ft' },
      { label: 'Squawk', value: '' },
      null,
      ...Array.from({ length: 30 }, (_, i) => ({ label: `f${i}`, value: 'v' })),
    ],
  });
  assert.equal(item.kind, 'Aircraft');
  assert.equal(item.notes.length, 300);
  assert.deepEqual(item.fields[0], { label: 'Callsign', value: 'UAL123', sub: null });
  assert.equal(item.fields[1].value, '11000');
  assert.ok(item.fields.every((f) => f.label !== 'Squawk'));
  assert.ok(item.fields.length <= 16);
  assert.deepEqual(Object.keys(item), ['kind', 'heading', 'fields', 'notes', 'link']);
  assert.throws(() => sanitizeItem({ kind: 'Aircraft' }), /heading/);
  assert.throws(() => sanitizeItem('nope'));
});

test('without a key the route is off and config says so', async () => {
  const { base, close } = await serve(createDescribeRoute({ apiKey: '' }));
  try {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.describe, null);
    assert.equal((await post(base, { kind: 'Earthquake', heading: 'M 6.1' })).status, 404);
  } finally {
    close();
  }
});

test('with a key the route describes the object once per press and reports the cost', async () => {
  const calls = [];
  const ask = async (item) => {
    calls.push(item);
    return { text: 'A magnitude 6.1 quake is strong enough to damage buildings near the epicentre.', usage: { input_tokens: 600, output_tokens: 100 } };
  };
  const { base, close } = await serve(createDescribeRoute({ apiKey: 'sk-test', ask, throttle: createThrottle({ minGapMs: 0, perHour: 100 }) }));
  try {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(config.describe, { model: 'claude-haiku-5-5' });
    const res = await post(base, { kind: 'Earthquake', heading: 'M 6.1 · 95 km E of Namie, Japan', fields: [{ label: 'Magnitude', value: '6.1 mb' }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.text, /magnitude 6.1/);
    assert.ok(Math.abs(body.costUsd - 0.00011) < 1e-9);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fields[0].value, '6.1 mb');
    const bad = await post(base, { kind: 'Earthquake' });
    assert.equal(bad.status, 400);
  } finally {
    close();
  }
});
