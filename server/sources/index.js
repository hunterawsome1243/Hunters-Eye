// Each data source is one module exporting { id, name, intervalMs, fetch() }.
// fetch() resolves to { data, count, note? } or throws; see lib/poller.js.
// To add a source: write a module like the ones below and add it to this list,
// then add a matching layer in public/js/layers/.
export const sources = [];
