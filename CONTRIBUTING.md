# Contributing and building on Hunter's Eye

Hunter's Eye is MIT licensed: you can fork it, change it, ship it, and build your own project on it. Keep the copyright notice in [LICENSE](LICENSE), and keep the map and imagery credit lines on screen (see [Credits](README.md#license-and-credits)).

Pull requests back to this repository are welcome too.

## Set up

You need Node.js 22 or newer (`nvm use` reads `.nvmrc`).

```bash
git clone https://github.com/<you>/Hunters-Eye.git
cd Hunters-Eye
npm install
npm run dev        # restarts the server when you edit server code
```

Open <http://localhost:3000>. No API keys are needed. Browser code in `public/` is served as plain ES modules with no build step, so a page reload picks up your changes.

## Check your change

```bash
npm test                     # unit tests, about a second
npx playwright install chromium   # once, for the browser test
npm run smoke -- --fake      # the whole app in headless Chromium against offline stand-ins
```

Both run on every pull request (`.github/workflows/ci.yml`). `npm run smoke` with no flag uses the live feeds, which is the real end-to-end check when your network allows it.

## Where things are

The [Project layout](README.md#project-layout) in the README maps every folder. The two contracts worth knowing:

- **A server source** (`server/sources/*.js`) exports `{ id, name, intervalMs, fetch() }`. The poller in `server/lib/poller.js` runs it on its schedule, caches the result and serves it to browsers. Sources never talk to the browser directly.
- **A globe layer** (`public/js/layers/*.js`) is `create(ctx)` returning the object documented at the top of [`public/js/layers/index.js`](public/js/layers/index.js). Its `id` matches the server source id.

## Add your own layer

[`examples/natural-events/`](examples/natural-events/) is a complete, tested layer (NASA EONET wildfires, volcanoes and storms) in two small files, with step by step instructions. Copying it is the fastest way to put your own data on the globe.

## Ground rules for data sources

- **Free and keyless by default.** Anyone who clones the repo should get a working globe with `npm start`. A source that needs a key should stay hidden until the key is set, like the Brief me button (`server/brief.js`).
- **Stay inside the provider's limits.** Read their rate limits, size `intervalMs` to them, and add a row to the [Data sources and limits](README.md#data-sources-and-limits) table.
- **Secrets stay on the server.** Read keys from the environment (`.env`, see `.env.example`); never send them to the browser or commit them.
- **Check the licence.** Imagery and map data must allow your use. The default globe imagery is the EOX Sentinel-2 cloudless **2016** mosaic because it is CC BY 4.0 worldwide; the 2017 mosaic only covers Europe and later years are non-commercial (CC BY-NC-SA).

## Code style

Plain modern JavaScript (ES modules), two-space indents, semicolons, single quotes. There is no linter; match the file you are editing. Comments explain why, not what. Add a unit test in `test/` for parsing or scheduling logic.

## Running your own copy online

The [Deploy on Render](README.md#deploy-on-render) section covers the free plan. If you publish your own copy, set `USER_AGENT` to your own name and contact URL: providers like the National Weather Service use it to reach whoever runs the app.
