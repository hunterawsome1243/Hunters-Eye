import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

const source = { id: 'aircraft', name: 'Aircraft', intervalMs: 60_000, fetch: async () => ({}), setOptions() {} };
async function serve(opts) {
  const { app, pollers } = createApp([source], { autoStart: false }, { imagery: null, ...opts });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { for (const p of pollers.values()) p.stop(); server.close(); } };
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
// What a caller sees: the status, that it is JSON, and the error line, with nothing of the server's insides.
async function answer(res) {
  const text = await res.text();
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.doesNotMatch(text, /<html|node_modules|server\/|\bat \w|\.js:\d/i, 'no HTML page and no stack trace');
  return { status: res.status, error: JSON.parse(text).error };
}

test('a request body that is broken, too big or in an unknown charset gets a line of JSON with its status', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  const { base, close } = await serve();
  try {
    assert.deepEqual(await answer(await post(`${base}/api/brief`, '{bad')), { status: 400, error: 'The request body is not valid JSON.' });
    assert.deepEqual(await answer(await post(`${base}/api/describe`, '{"kind": ')), { status: 400, error: 'The request body is not valid JSON.' });
    const big = await fetch(`${base}/api/sources/aircraft/options`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(8000) }) });
    assert.deepEqual(await answer(big), { status: 413, error: 'The request body is too large.' });
    const charset = await answer(await post(`${base}/api/brief`, '{}', { 'Content-Type': 'application/json; charset=latin9' }));
    assert.equal(charset.status, 415);
    assert.match(charset.error, /unsupported charset/);
    const stale = await fetch(`${base}/index.html`, { headers: { Range: 'bytes=999999999-' } }); // a static file's own refusal
    assert.deepEqual(await answer(stale), { status: 416, error: 'Range Not Satisfiable' });
    const gzip = await answer(await post(`${base}/api/brief`, 'not gzip', { 'Content-Encoding': 'gzip' }));
    assert.equal(gzip.status, 400);
    assert.deepEqual(logged, [], "the caller's mistakes are not logged as the server's");
  } finally {
    close();
  }
});

test('a route that throws is logged here and answered without detail', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  let status;
  const failing = { enabled: true, model: 'm', bodyLimit: '1kb', handler: () => { throw Object.assign(new Error('secret detail at /srv/app/server/brief.js:12'), { status }); } };
  const { base, close } = await serve({ brief: failing });
  try {
    // no status, or one that is not an error status, is the server's own failure
    for (status of [undefined, '404', 200, 302, 1000]) {
      assert.deepEqual(await answer(await post(`${base}/api/brief`, '{}')), { status: 500, error: 'Something went wrong on the server.' }, `status ${status}`);
    }
    assert.equal(logged.length, 5);
    assert.match(logged[0][0], /^POST \/api\/brief:/);
    assert.match(logged[0][1].message, /secret detail/);
  } finally {
    close();
  }
});
