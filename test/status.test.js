import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStatus } from '../public/js/ui/status.js';

const now = 1_700_000_000_000;
const row = (id, over = {}) => ({ id, name: id, loading: false, error: null, updatedAt: now - 12_000, intervalMs: 60_000, ...over });

test('all sources fresh reads as live with the newest update time', () => {
  const d = describeStatus([row('a'), row('b', { updatedAt: now - 90_000 })], { now });
  assert.equal(d.state, 'live');
  assert.equal(d.label, 'Live');
  assert.equal(d.detail, 'updated 12s ago');
  assert.equal(d.banner, null);
});

test('nothing loaded yet is connecting, partly loaded is loading', () => {
  assert.equal(describeStatus([], { now }).state, 'loading');
  assert.equal(describeStatus([row('a', { loading: true, updatedAt: null })], { now }).label, 'Connecting');
  const d = describeStatus([row('a'), row('b', { loading: true, updatedAt: null })], { now });
  assert.equal(d.state, 'loading');
  assert.equal(d.label, 'Loading');
});

test('failing feeds are counted, and still show when the data was last good', () => {
  const one = describeStatus([row('a'), row('b', { error: 'HTTP 503' })], { now });
  assert.equal(one.state, 'degraded');
  assert.equal(one.label, '1 feed failing');
  assert.equal(one.detail, 'updated 12s ago');
  const two = describeStatus([row('a', { error: 'x' }), row('b', { error: 'y' })], { now });
  assert.equal(two.label, 'All feeds failing');
});

test('a source older than three intervals (at least five minutes) is stale, and the pill names it', () => {
  const d = describeStatus([row('a'), row('b', { updatedAt: now - 6 * 60_000 })], { now });
  assert.equal(d.state, 'stale');
  assert.equal(d.label, '1 feed stale');
  assert.equal(d.detail, 'oldest 6m ago');
  assert.equal(describeStatus([row('b', { updatedAt: now - 4 * 60_000 })], { now }).state, 'live');
  assert.equal(describeStatus([row('a', { updatedAt: now - 7 * 60_000 }), row('b', { updatedAt: now - 6 * 60_000 })], { now }).label, 'All feeds stale');
});

test('a failing feed outranks a stale one, and a failure with no data anywhere has no time to show', () => {
  const d = describeStatus([row('a', { updatedAt: now - 6 * 60_000 }), row('b', { error: 'HTTP 503' })], { now });
  assert.equal(d.state, 'degraded');
  const none = describeStatus([row('a', { error: 'x', updatedAt: null })], { now });
  assert.equal(none.label, 'All feeds failing');
  assert.equal(none.detail, '');
});

test('the clock in offline wording never breaks across a line', () => {
  const d = describeStatus([row('a')], { serverDown: true, now });
  assert.ok(!/\d \w*M/.test(d.banner), d.banner);
});

test('a dead server shows offline and a banner naming the last good data', () => {
  const d = describeStatus([row('a')], { serverDown: true, now });
  assert.equal(d.state, 'offline');
  assert.match(d.detail, /^data from \d/);
  assert.match(d.banner, /^Can't reach the server\. Showing data from \d/);
  const empty = describeStatus([], { serverDown: true, now });
  assert.equal(empty.detail, 'no data yet');
  assert.equal(empty.banner, "Can't reach the server.");
});
