// Every map layer is one module whose default export is create(ctx) and returns:
//   {
//     id, name, source, color,   // id matches the server source id (server/sources/)
//     visible,                    // current toggle state; app.js flips it, modules read it
//     layerIds,                   // every style layer id the module adds, bottom to top (app.js toggles them)
//     interactive,                // [{ layer, priority }] layers that take clicks; higher priority wins
//     mount(),                    // add sources, images and layers to the current style through
//                                 // ctx.addSource/addLayer/addImage and re-push cached data. Idempotent:
//                                 // it runs after every style load (start style, basemap swap).
//     update(data),               // fresh data from /api/sources/<id>, or the same shape from the browser fallback
//     count(),                    // number shown in the summary bar
//     clearSelection(),           // another layer took the selection, or the layer was hidden
//     focusFirst(),               // select a representative item (used by the smoke test)
//     pick(feature, event),       // a ranked click hit on one of `interactive`; return true if taken
//     acceptsFeed?(entry),        // hide some of this layer's feed entries (filters)
//     onStatus?(status),          // the latest status for this source (the server's, or the browser fallback's)
//     fetchOptions?(),            // what the browser fallback should fetch, like the server's options
//     onShow?(), onHide?(),
//   }
// ctx gives { map, globe, addSource(id, spec), addLayer(spec, tier), addImage(id, img, opts), hasGlyphs(),
//   ready(), blockSpin(key, on), phone(), isVisible(id), clockOffset(), feed, detail, addFilter(node), select(layer),
//   viewBounds(), contains(lon, lat), onView(fn), flyTo({ center, zoom?, minZoom?, maxZoom? }), fitBounds(b, opts) }.
// map.setFilter / setLayoutProperty / setFeatureState throw while a style is loading: call them only
// when ctx.ready() is true, and have mount() re-apply the current filter and selection.
// Tiers for addLayer, bottom to top: shapes, tracks, planes, points, labels, top.
// GeoJSON coordinates are [lon, lat]. To add a layer, write a module like these and add it to the list.
import aircraft from './aircraft.js';
import earthquakes from './earthquakes.js';
import satellites from './satellites.js';
import weather from './weather.js';

// Sidebar, filter and chip order.
export const layerModules = [earthquakes, aircraft, satellites, weather];
// Mount order within a tier (what draws on top when two share a tier).
export const DRAW_ORDER = ['weather', 'aircraft', 'satellites', 'earthquakes'];
