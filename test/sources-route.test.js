import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

test('a source is turned into JSON once per version, whatever the number of viewers', async () => {
  let version = 1;
  let serialised = 0;
  const payload = (v) => ({ v, toJSON() { serialised++; return { v, items: [1, 2, 3] }; } });
  const source = { id: 'quakes', name: 'Quakes', intervalMs: 60_000, fetch: async () => ({ data: payload(version), count: 3, updatedAt: 1000 * version }) };
  const { app, pollers } = createApp([source], {}, { imagery: null });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const poller = pollers.get('quakes');
  try {
    await poller.poll();
    const reads = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/api/sources/quakes`)));
    for (const res of reads) {
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.equal(res.headers.get('etag'), null);
      const body = await res.json();
      assert.deepEqual(body.data, { v: 1, items: [1, 2, 3] });
      assert.equal(body.status.updatedAt, 1000);
      assert.equal(body.status.ok, true);
    }
    assert.equal(serialised, 1);
    version = 2;
    await poller.poll();
    const next = await (await fetch(`${base}/api/sources/quakes`)).json();
    assert.equal(next.data.v, 2);
    assert.equal(next.status.updatedAt, 2000);
    assert.equal(serialised, 2);
    assert.equal((await fetch(`${base}/api/sources/nope`)).status, 404);
  } finally {
    for (const p of pollers.values()) p.stop();
    server.close();
  }
});

test('a source with no data yet answers null data and its loading status', async () => {
  const source = { id: 'slow', name: 'Slow', intervalMs: 60_000, fetch: () => new Promise(() => {}) };
  const { app, pollers } = createApp([source], {}, { imagery: null });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/sources/slow`)).json();
    assert.equal(body.data, null);
    assert.equal(body.status.loading, true);
  } finally {
    for (const p of pollers.values()) p.stop();
    server.close();
  }
});
