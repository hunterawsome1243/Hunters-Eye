// Every map layer is one module whose default export is create(ctx) and returns:
//   {
//     id, name, source, color,   // id matches the server source id (server/sources/)
//     layer,                      // a Leaflet layer added to / removed from the map by the toggle
//     visible,                    // initial toggle state
//     update(data),               // called with fresh data from /api/sources/<id>
//     count(),                    // number shown in the summary bar
//     clearSelection(),           // another layer took the selection
//     focusFirst(),               // select a representative item (used by the smoke test)
//     acceptsFeed?(entry),        // hide some of this layer's feed entries (filters)
//     onStatus?(status),         // the server's latest status for this source
//     onShow?(), onHide?(),
//   }
// ctx gives { map, feed, detail, addFilter(node), select(layer), isVisible(id) }.
// To add a layer, write a module like these and add it to the list.
import aircraft from './aircraft.js';
import earthquakes from './earthquakes.js';
import satellites from './satellites.js';
import weather from './weather.js';

export const layerModules = [earthquakes, aircraft, satellites, weather];
