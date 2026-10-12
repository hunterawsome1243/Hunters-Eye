import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startFakeUpstream, routes } from '../scripts/fake-upstream.mjs';

let upstream;
let cacheDir;
let source;
let parseTle;
let hits = 0;
let fail403 = false;

before(async () => {
  const original = routes['/celestrak'];
  routes['/celestrak'] = (req) => {
    hits++;
    if (fail403) return { status: 403, body: 'GP data has not updated since your last successful download' };
    return original(req);
  };
  upstream = await startFakeUpstream();
  cacheDir = mkdtempSync(join(tmpdir(), 'he-sat-'));
  process.env.CELESTRAK_URL = `http://127.0.0.1:${upstream.address().port}/celestrak`;
  process.env.CACHE_DIR = cacheDir;
  const mod = await import('../server/sources/satellites.js');
  source = mod.default;
  parseTle = mod.parseTle;
});

after(() => {
  upstream.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

test('parses three-line element sets and marks notable satellites', () => {
  const text = routes['/celestrak']({ url: '/celestrak?GROUP=STATIONS' });
  const sats = parseTle(text, 'STATIONS');
  assert.equal(sats.length, 2);
  assert.equal(sats[0].id, '25544');
  assert.equal(sats[0].notable, 'ISS');
  assert.ok(sats[0].line1.startsWith('1 25544'));
});

test('downloads each group once, then serves from the disk cache', async () => {
  hits = 0;
  const first = await source.fetch();
  assert.equal(first.count, 6);
  assert.equal(hits, 2);
  const second = await source.fetch();
  assert.equal(second.count, 6);
  assert.equal(hits, 2, 'no new downloads within 2 hours');
  assert.ok(first.nextDelayMs > 60 * 60_000, 'next check is about 2 hours out');
});

test('a 403 from CelesTrak keeps the cached data instead of failing', async () => {
  const { utimesSync, readdirSync } = await import('node:fs');
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  for (const f of readdirSync(cacheDir)) utimesSync(join(cacheDir, f), old, old);
  fail403 = true;
  const res = await source.fetch();
  assert.equal(res.count, 6);
  assert.match(res.note, /cached/i);
});
