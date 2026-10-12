// Each data source is one module exporting { id, name, intervalMs, fetch() }.
// fetch() resolves to { data, count, note?, nextDelayMs? } or throws; see lib/poller.js.
// To add a source: write a module like the ones below and add it to this list,
// then add a matching layer in public/js/layers/.
import aircraft from './aircraft.js';
import earthquakes from './earthquakes.js';
import satellites from './satellites.js';

export const sources = [earthquakes, aircraft, satellites];
