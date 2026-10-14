# Example: add a "Natural events" layer

This folder is a complete new layer for the globe: open natural events from [NASA EONET](https://eonet.gsfc.nasa.gov/docs/v3) (wildfires, volcanoes, severe storms, sea and lake ice). EONET is free and needs no key. It is not switched on in the app; follow the four steps below to add it, then use it as a template for your own data.

| File | Goes to | What it does |
| --- | --- | --- |
| `source.js` | `server/sources/events.js` | Downloads the feed every 15 minutes on the server and turns it into a small list of events |
| `layer.js` | `public/js/layers/events.js` | Draws the events as dots on the globe, opens a detail panel on click, adds them to the live feed |
| `sample.geojson` | stays here | A tiny copy of the feed's shape, for trying it without a network |

## 1. Copy the two files

```bash
cp examples/natural-events/source.js server/sources/events.js
cp examples/natural-events/layer.js public/js/layers/events.js
```

## 2. Register the server source

In `server/sources/index.js`:

```js
import events from './events.js';

export const sources = [earthquakes, aircraft, satellites, weather, events];
```

## 3. Register the globe layer

In `public/js/layers/index.js`:

```js
import events from './events.js';

export const layerModules = [earthquakes, aircraft, satellites, weather, events];
export const DRAW_ORDER = ['weather', 'aircraft', 'satellites', 'events', 'earthquakes'];
```

`layerModules` sets the order of the chips and filters; `DRAW_ORDER` decides what draws on top.

## 4. Run it

```bash
npm start
```

A **Natural events** chip appears in the summary bar with its count and health dot, the dots appear on the globe, and new events show up in the live feed. The chip, health indicator, refresh logic and feed come from the app; the two files only fetch and draw.

To try it with no network, serve the sample file and point the source at it:

```bash
cd examples/natural-events && python3 -m http.server 8765 &
EONET_URL=http://127.0.0.1:8765/sample.geojson npm start
```

## Make it your own

- **Different data:** change the URL and `normalize()` in `source.js` so each item has an `id`, `lat`, `lon` and whatever you want to show. Keep `intervalMs` inside the provider's rate limits.
- **Different look:** change `COLOR` and the `paint` block in `layer.js`. Any [MapLibre layer type](https://maplibre.org/maplibre-style-spec/layers/) works: `circle`, `symbol` for icons, `line` for tracks, `fill` for areas (see `weather.js` and `satellites.js` for those).
- **Filters:** see how `earthquakes.js` adds a slider with `ctx.addFilter()` and a `count()` that respects it.
- **Testing:** add a unit test for `normalize()` in `test/` (see `test/earthquakes.test.js`).

This example was checked end to end with `EONET_URL` pointing at `sample.geojson` (`npm run smoke -- --fake` clicks it like every other layer). The live EONET response was not reachable from the network it was built on, so check `normalize()` against a real response the first time you run it.
