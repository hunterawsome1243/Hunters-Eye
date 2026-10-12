import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startFakeUpstream } from '../scripts/fake-upstream.mjs';

let upstream;
let dir;

before(async () => {
  upstream = await startFakeUpstream();
  dir = mkdtempSync(join(tmpdir(), 'he-sat-ro-'));
  const notADir = join(dir, 'file');
  writeFileSync(notADir, 'x');
  process.env.CELESTRAK_URL = `http://127.0.0.1:${upstream.address().port}/celestrak`;
  process.env.CACHE_DIR = join(notADir, 'cache'); // any write fails with ENOTDIR
});

after(() => {
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an unwritable cache directory does not break the satellite feed', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const source = (await import('../server/sources/satellites.js')).default;
    const res = await source.fetch();
    assert.equal(res.count, 6);
    const again = await source.fetch();
    assert.equal(again.count, 6, 'served from memory');
  } finally {
    console.warn = warn;
  }
});
