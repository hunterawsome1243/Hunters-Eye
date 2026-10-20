import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHere } from '../public/js/ui/here.js';

// The browser's location, answered by hand: geo.answer(ok) settles the pending request.
function stubGeolocation() {
  const geo = { calls: 0, pending: [] };
  geo.api = {
    getCurrentPosition(ok, fail) {
      geo.calls++;
      geo.pending.push({ ok, fail });
    },
  };
  geo.answer = (allow) => {
    const { ok, fail } = geo.pending.shift();
    if (allow) ok({ coords: { latitude: 51.5, longitude: -0.12 } });
    else fail({ code: 1, message: 'denied' });
  };
  Object.defineProperty(globalThis, 'navigator', { value: { geolocation: geo.api }, configurable: true, writable: true });
  return geo;
}
// /api/whereami, answered by hand: server.answer(body | null) settles the next request.
function stubServer() {
  const server = { calls: 0, pending: [] };
  server.fetch = () => new Promise((resolve, reject) => { server.calls++; server.pending.push({ resolve, reject }); });
  server.answer = (body) => {
    const { resolve } = server.pending.shift();
    resolve(body ? Response.json(body) : Response.json({ error: 'Could not place your address: lookup service unavailable' }, { status: 502 }));
  };
  server.drop = () => server.pending.shift().reject(new TypeError('Failed to fetch'));
  return server;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a crosshair press during the automatic lookup still asks the browser, and flies to its answer', async () => {
  const geo = stubGeolocation();
  const server = stubServer();
  const flights = [];
  const here = createHere({ map: null, flyTo: (to) => flights.push(to.center), fetchImpl: server.fetch });
  const auto = here.locate({ fly: false }); // the proximity feed at load: address only
  const press = here.toggle();
  await tick();
  server.answer({ lat: 40, lon: -105, place: 'Denver' });
  assert.equal((await auto).place, 'Denver');
  await tick();
  assert.equal(geo.calls, 1); // the press asked the browser after all
  geo.answer(true);
  await press;
  assert.equal(here.position().source, 'browser');
  assert.deepEqual(flights, [[-0.12, 51.5]]);
});

test('the feed\'s Try again during a crosshair lookup shares it instead of failing at once', async () => {
  const geo = stubGeolocation();
  const server = stubServer();
  const here = createHere({ map: null, flyTo: () => {}, fetchImpl: server.fetch });
  const press = here.toggle();
  const retry = here.locate({ browser: true }); // the feed's button, while the press waits on the browser
  let settled = false;
  retry.then(() => { settled = true; });
  await tick();
  geo.answer(false);
  await tick();
  assert.equal(settled, false); // still waiting with the press's lookup
  server.drop(); // and the server can't be reached
  assert.equal(await retry, null);
  await press;
  assert.equal(geo.calls, 1);
  assert.equal(server.calls, 1);
  assert.equal(here.error(), "can't reach the server; you did not allow the browser to share your location");
});

test('the feed\'s Find me during a crosshair lookup gets that lookup\'s place', async () => {
  const geo = stubGeolocation();
  const server = stubServer();
  const here = createHere({ map: null, flyTo: () => {}, fetchImpl: server.fetch });
  const press = here.toggle();
  const findMe = here.locate({ browser: true });
  await tick();
  geo.answer(false);
  await tick();
  server.answer({ lat: 40, lon: -105, place: 'Denver' });
  assert.equal((await findMe)?.place, 'Denver');
  await press;
  assert.equal(geo.calls, 1);
  assert.equal(server.calls, 1);
});

test('removing the marker while the browser is still being asked keeps it removed', async () => {
  const geo = stubGeolocation();
  const server = stubServer();
  const flights = [];
  const stored = new Map();
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v), removeItem: (k) => stored.delete(k) }, configurable: true, writable: true });
  try {
    const here = createHere({ map: null, flyTo: (to) => flights.push(to.center), fetchImpl: server.fetch });
    here.locate({ fly: false }); // the automatic lookup at load
    const press = here.toggle();
    await tick();
    server.answer({ lat: 40, lon: -105, place: 'Denver' }); // the address answers; the press now asks the browser
    await tick();
    await tick();
    assert.equal(geo.calls, 1);
    assert.equal(here.position()?.place, 'Denver');
    await here.toggle(); // the marker is up, so this press removes it
    geo.answer(true); // then the browser answers the earlier press
    await press;
    assert.equal(here.position(), null);
    assert.equal(stored.has('he.here'), false);
    assert.deepEqual(flights, []);
    const again = here.toggle(); // and a later press asks afresh
    await tick();
    assert.equal(geo.calls, 2);
    geo.answer(true);
    await again;
    assert.equal(here.position()?.source, 'browser');
  } finally {
    delete globalThis.localStorage;
  }
});
