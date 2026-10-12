# Hunter's Eye

An open-source intelligence (OSINT) dashboard that fuses four free public data feeds onto one live, dark world map:

| Layer | What you see | Source |
| --- | --- | --- |
| **Earthquakes** | Circles sized by magnitude, colored by age (past hour, 6 hours, day, older) | USGS real-time GeoJSON feed |
| **Aircraft** | Plane icons rotated to heading, colored by altitude, positions estimated between refreshes | OpenSky Network |
| **Satellites** | ISS, Tiangong, Hubble and ~150 bright objects, positions computed live in the browser with satellite.js; the selected satellite's ground track and visibility footprint | CelesTrak |
| **Severe weather** | Active US alerts drawn as shaded areas, colored by severity | US National Weather Service |

Other features:

- Click anything on the map (or in the feed) to open a detail panel: magnitude, depth and time for a quake; callsign, altitude, speed and squawk for a plane; name, altitude, speed and orbit for a satellite; full alert text for weather.
- A **live feed** down the side, newest first, mixing all layers: new earthquakes, new weather alerts, aircraft squawking emergency codes (7500/7600/7700), satellite element updates, and any feed failing or recovering.
- A **summary bar** with one chip per layer: on/off toggle, item count, time of the last update and a health dot (green ok, grey loading, amber stale, red failed). Hover a chip for the error message, the next refresh time and the source's notes.
- **Filters**: minimum earthquake magnitude, only aircraft in the current map view, only notable satellites, minimum weather severity.
- Each source refreshes on its own schedule, sized to that source's rate limits. If one feed fails, its chip turns red, the last good data stays on the map, and the other layers keep running.
- If the server can't reach OpenSky or CelesTrak at all, your browser fetches that feed itself and the chip says **via browser**. See [Browser fallback](#browser-fallback).

## Run it

Needs Node.js 22 or newer.

```bash
npm install
npm start
```

Then open <http://localhost:3000>. That is the only command; no API keys are needed.

Optional settings live in `.env` (copy `.env.example`). The most useful one is a free OpenSky API client, which makes aircraft refresh every ~1.5 minutes instead of every ~17. See [Configuration](#configuration).

`npm run dev` restarts the server when you edit server code.

## How it works

```
browser ──/api/status every 5 s──▶  Node server (Express)  ──on each source's own schedule──▶  USGS / OpenSky / CelesTrak / NWS
        ◀─/api/sources/<id> only when that source has new data──┘   (in-memory cache, disk cache for satellites and weather zones)
```

- The **server** (`server/`) polls each upstream API on a fixed schedule and keeps the latest result in memory. Browsers only ever read from that cache, so opening ten tabs does not make ten times the upstream calls, and there are no cross-origin problems. When no browser has asked for anything in 10 minutes, polling pauses, so an idle server uses none of your rate-limit budget. Waking up still respects the previous interval.
- The **browser** (`public/`) polls `/api/status` every 5 seconds. That small response carries every source's health, count and version; the browser downloads a source's data only when its version changes.
- Leaflet, MapLibre, satellite.js and the app's own modules are served by the local server, so normally the only third-party requests the page makes are for the basemap.

### Browser fallback

Some hosts can't reach every feed. From Render's Oregon region, OpenSky and CelesTrak both time out; they most likely block Render's shared outbound addresses. So when the server reports aircraft or satellites as failed **and has no data for them**, the browser fetches that feed straight from the provider (`public/js/fallback.js`):

- **Satellites**: the same 2-hour rule as the server. Each group is downloaded at most once per CelesTrak update and kept in the browser's localStorage, so reloading the page doesn't download again. A 403 keeps the cached copy. Without a cache it retries every 10 minutes.
- **Aircraft**: anonymous OpenSky only, because the API client secret must stay on the server. That is 400 credits a day for the viewer's own connection, so a whole-world refresh every ~17 minutes (faster with "only aircraft in current view"). The last request time is shared across tabs, a reload waits at least a minute, and a 429 pauses requests for an hour.
- It stops as soon as the server has data again, and it uses the same parsing and budgeting code as the server (`shared/`).
- It only works when the provider allows requests from other web pages (CORS). CelesTrak does (checked October 2026). OpenSky couldn't be checked from a cloud network because it doesn't answer those at all. If the browser is refused too, the chip stays red and its tooltip says that both the server and the browser failed.

Set `BROWSER_FALLBACK=off` to turn it off.

## Data sources and limits

All four are free and need no paid plan. Limits below were checked against each provider's documentation in October 2026.

| Source | Endpoint used | Limits | How this app stays inside them |
| --- | --- | --- | --- |
| [USGS Earthquake Hazards](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php) | `summary/all_day.geojson` | No published rate limit; the file is regenerated every minute. | Fetched once a minute. |
| [OpenSky Network](https://openskynetwork.github.io/opensky-api/rest.html) | `/api/states/all?extended=1` | Anonymous: 400 credits/day. Free account API client: 4,000/day. A request costs 1 credit (box up to 25 sq°), 2 (up to 100), 3 (up to 400) or 4 (larger or global). HTTP 429 when credits run out. Basic auth with username/password no longer works; API clients use OAuth2 client credentials. | After each request the server waits *cost × 24 h ÷ daily credits*, plus 15%. Global view: every ~17 min anonymous, ~1.5 min with an API client. With "only aircraft in current view" the server queries a padded box around your view, which costs fewer credits and so refreshes faster (down to ~4 min anonymous, ~25 s with a client). Honors `X-Rate-Limit-Retry-After-Seconds` on 429. |
| [CelesTrak](https://celestrak.org/NORAD/documentation/gp-data-formats.php) | `gp.php?GROUP=STATIONS&FORMAT=TLE` and `GROUP=VISUAL` | Data updates about every 2 hours. Since March 2026 a repeat download before the next update gets HTTP 403. More than 50 errors (301/403/404) in 2 hours gets your IP firewalled. | Each group is cached on disk (`data/cache/`) and downloaded at most once every 2 hours, including across restarts. A 403 keeps the cached data. After any error the server waits 30 minutes. Positions are computed in the browser every second, so no further requests are needed. |
| [National Weather Service](https://www.weather.gov/documentation/services-web-api) | `/alerts/active?status=actual`, plus `/zones/{type}/{id}` | Requires a `User-Agent`. Limits are not published but described as generous; errors clear within about 5 seconds. | Alerts every 2 minutes. Zone- and county-based alerts arrive without a shape, so their outlines come from the zones endpoint, as the [NWS geolocation guide](https://www.weather.gov/media/documentation/docs/NWS_Geolocation.pdf) recommends. Each zone is downloaded once, simplified and cached on disk; at most 300 per cycle, 4 at a time, most severe alerts first. |
| [OpenFreeMap](https://openfreemap.org/) | `tiles.openfreemap.org/styles/dark` (vector tiles from OpenStreetMap data) | Free, including commercial use. No API key, no sign-up, no stated request limits; runs on donations. | Loaded directly by the browser and drawn with MapLibre GL inside Leaflet. Credit line shown on the map. |

**One source was swapped: the basemap.** The app first used CARTO's free Dark Matter tiles, but in 2026 CARTO began requiring an API key and now stamps "API key required" across maps without one. OpenFreeMap's dark style replaced it because it needs no key. To use another MapLibre style, set `BASEMAP_STYLE`.

## Configuration

Everything is optional. Copy `.env.example` to `.env` and fill in what you need; real environment variables take precedence.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `127.0.0.1` | Interface to listen on. Use `0.0.0.0` to open the dashboard to other devices on your network. Everyone then shares one server cache, including the aircraft view box. |
| `USER_AGENT` | `HuntersEye/0.1 (+repo URL)` | Sent to every API. NWS requires one; adding your email lets them contact you. |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | empty | A free OpenSky API client (sign in at opensky-network.org, Account page, create an API client). Raises aircraft credits from 400 to 4,000 a day. |
| `EARTHQUAKES_INTERVAL_SEC`, `AIRCRAFT_INTERVAL_SEC`, `WEATHER_INTERVAL_SEC` | safe defaults | Override a refresh interval. The aircraft override skips the credit budgeting, so you can run out of credits. |
| `CACHE_DIR` | `data/cache` | Where satellite elements and weather zone outlines are cached. Empty means memory only. |
| `BASEMAP_STYLE` | OpenFreeMap dark | URL of the MapLibre style drawn under the layers, such as another OpenFreeMap style or your own tile server. |
| `BROWSER_FALLBACK` | on | `off` stops browsers from fetching OpenSky and CelesTrak themselves when the server can't reach them. See [Browser fallback](#browser-fallback). |

`.env` is in `.gitignore`; never commit real credentials.

## Deploy on Render

The repo includes a `render.yaml` Blueprint. In the Render dashboard choose **New > Blueprint**, pick this repository, and fill in the two OpenSky values when asked. On Render the server listens on `0.0.0.0:$PORT` automatically, and `/healthz` serves health checks without waking the feeds.

Things that work differently on a hosted server:

- **Aircraft and satellites come from your browser.** In October 2026 OpenSky and CelesTrak both timed out from Render's Oregon region, so the [browser fallback](#browser-fallback) fills in and those chips say "via browser". Earthquakes and weather load on the server as usual.
- **An OpenSky API client only helps if the server can reach OpenSky.** Anonymous OpenSky credits are counted per IP address and Render's outbound addresses are shared with other customers, so add a client if your region can reach OpenSky. The browser fallback is always anonymous.
- **Satellites may fail to load on the server after a restart.** The free plan wipes the disk on every restart and spin-down, so the CelesTrak cache is lost. If anyone on the same outbound address downloaded the same group in the last 2 hours, CelesTrak answers 403. A paid instance with a persistent disk set as `CACHE_DIR` avoids this.
- **Free instances sleep.** After 15 minutes with no visitors the service spins down. The first visit afterwards takes about a minute, then each feed loads on its first refresh.
- **Everyone shares one server.** All visitors see the same cache, and the "only aircraft in current view" box is shared too: the last visitor to move the map with the filter on decides the area for everyone.

## Testing

```bash
npm test                    # unit tests: poller, parsers, rate budgeting, caching, geometry
npm run smoke               # end to end against the LIVE feeds
npm run smoke -- --fake     # end to end against local stand-ins (works offline)
npm run smoke -- --fake --server-blocked    # server can't reach OpenSky/CelesTrak; checks the browser fallback
npm run smoke -- --fake --browser-blocked   # ...and the browser is refused too; checks the error message
```

The smoke test starts the server, opens the dashboard in headless Chromium, waits for every source, checks each layer has items, clicks an item in each layer and a plane on the map, checks the view filter reaches the server, and fails on any browser console error or server warning. It saves a screenshot to `docs/screenshot.png`. It needs a Playwright Chromium once: `npx playwright install chromium` (or set `CHROMIUM_PATH` to an existing Chrome/Chromium).

The `--fake` stand-ins (`scripts/fake-upstream.mjs`) mirror each API's documented response shape, so you can test the whole app with no network.

## Project layout

```
server/
  index.js            starts the server
  app.js              Express routes: static files, /api/status, /api/sources/:id, PUT /api/sources/:id/options
  lib/poller.js       runs one source on its schedule, caches the result, pauses when idle
  lib/http.js         fetch with User-Agent, timeout, readable errors and retry-after
  lib/geometry.js     polygon simplification for weather outlines
  sources/            one module per data source: earthquakes, aircraft, satellites, weather
shared/               OpenSky and CelesTrak parsing and budgeting, used by the server and the browser fallback
public/
  index.html, css/style.css
  js/app.js           map, status polling, wiring
  js/fallback.js      fetches OpenSky and CelesTrak from the browser when the server can't
  js/layers/          one module per map layer, matching the server sources
  js/ui/              summary bar, live feed, detail panel, formatting helpers
scripts/              smoke test and the fake upstream APIs
test/                 unit tests (node:test)
```

### Adding a data source

1. Write `server/sources/<name>.js` exporting `{ id, name, intervalMs, fetch() }`, where `fetch()` returns `{ data, count }` (optionally `note` and `nextDelayMs`) or throws. Add it to `server/sources/index.js`.
2. Write `public/js/layers/<name>.js` with a default `create(ctx)` that returns the layer object described at the top of `public/js/layers/index.js`, and add it to the list there.

The summary chip, health indicator, feed integration and refresh logic come for free.

## What I learned

_Fill this in as you go:_

-
-
-
