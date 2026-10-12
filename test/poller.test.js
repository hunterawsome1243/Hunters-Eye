import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourcePoller } from '../server/lib/poller.js';

const tick = () => new Promise((r) => setImmediate(r));

test('keeps the last good data and reports the error when a fetch fails', async () => {
  let fail = false;
  const poller = new SourcePoller({
    id: 'x', name: 'X', intervalMs: 60_000,
    async fetch() {
      if (fail) throw Object.assign(new Error('upstream down'), { retryAfterMs: 120_000 });
      return { data: [1, 2, 3], count: 3 };
    },
  });
  poller.lastRequested = Date.now();
  await poller.run();
  assert.equal(poller.status().ok, true);
  assert.equal(poller.status().count, 3);

  fail = true;
  await poller.run();
  const s = poller.status();
  assert.equal(s.ok, false);
  assert.equal(s.error, 'upstream down');
  assert.deepEqual(poller.data, [1, 2, 3], 'previous data is kept');
  assert.ok(s.nextAt - Date.now() > 110_000, 'honours retry-after');
  poller.stop();
});

test('does not call upstream when nobody has asked for data recently', async () => {
  let calls = 0;
  const poller = new SourcePoller({ id: 'x', name: 'X', intervalMs: 1000, fetch: async () => ({ data: ++calls }) }, { idleMs: 1000 });
  poller.lastRequested = Date.now() - 5000;
  await poller.run();
  assert.equal(calls, 0);
  poller.touch();
  await tick();
  await poller.inflight;
  assert.equal(calls, 1);
  poller.stop();
});

test('uses the delay a source asks for', async () => {
  const poller = new SourcePoller({ id: 'x', name: 'X', intervalMs: 1000, fetch: async () => ({ data: 1, nextDelayMs: 500_000 }) });
  poller.lastRequested = Date.now();
  await poller.run();
  assert.ok(poller.nextAt - Date.now() > 490_000);
  poller.stop();
});

test('concurrent runs share one upstream request', async () => {
  let calls = 0;
  const poller = new SourcePoller({ id: 'x', name: 'X', intervalMs: 1000, fetch: async () => { calls++; await tick(); return { data: 1 }; } });
  poller.lastRequested = Date.now();
  await Promise.all([poller.run(), poller.run(), poller.run()]);
  assert.equal(calls, 1);
  poller.stop();
});

test('waking from idle still waits out the previous interval', async () => {
  let calls = 0;
  const poller = new SourcePoller({ id: 'x', name: 'X', intervalMs: 600_000, fetch: async () => ({ data: ++calls }) }, { idleMs: 1000 });
  poller.lastRequested = Date.now();
  await poller.run();
  poller.stop();
  poller.touch();
  assert.ok(poller.nextAt - Date.now() > 590_000, 'next call is still ~10 minutes out');
  assert.equal(calls, 1);
  poller.stop();
});
