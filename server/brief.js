import Anthropic from '@anthropic-ai/sdk';

// "Brief me": a short plain-language summary of what the dashboard is showing,
// written by Claude on demand. The browser sends a compact snapshot (layer
// counts, feed health, the latest events); this server adds the key and calls
// the API, so the key never reaches the browser. Without ANTHROPIC_API_KEY the
// route answers 404 and the button is never shown.
//
// Cost: Haiku 5.5 is $0.10 per million input tokens and $0.50 per million
// output tokens. A brief is roughly 1,500 tokens in and 250 out, about
// $0.0003 (a few hundredths of a cent). The throttle below caps a public
// deployment at 20 briefs an hour, so the worst case is about half a cent an hour.
export const DEFAULT_MODEL = 'claude-haiku-5-5';
const PRICE = { 'claude-haiku-5-5': { input: 0.1, output: 0.5 } }; // USD per million tokens
const MAX_EVENTS = 40;
const MAX_BODY = '128kb'; // the sanitiser below is the real bound

const SYSTEM = `You write the situation brief for "Hunter's Eye", a public dashboard that shows live earthquakes (USGS), aircraft positions (OpenSky Network), satellites (CelesTrak orbital elements) and US severe weather alerts (National Weather Service) on a 3D globe.
You get a JSON snapshot of what the dashboard currently shows. Write what an analyst would say out loud to a colleague who just walked in: the few things that matter, in plain English.
Rules:
- 80 to 140 words, as 3 to 5 short paragraphs. No headings, no bullet lists, no markdown.
- Lead with the most significant item (strong earthquakes, extreme or severe weather, aircraft squawking emergency codes), then the general picture.
- Use only what the snapshot says. Do not guess causes or add facts the data does not contain. Round numbers sensibly.
- If a feed is failing or stale, say so in one sentence at the end. If a layer is hidden, do not describe its items.
- Mention the viewed area only if the snapshot has a view box; otherwise the view is the whole world.
- Times in the snapshot are ISO 8601 UTC; refer to them as "about N minutes ago" style, relative to "now" in the snapshot.`;

// Trims the browser's snapshot to what the prompt needs: no free text beyond the
// titles the dashboard already shows, and a hard cap on size.
export function sanitizeSnapshot(body) {
  if (!body || typeof body !== 'object') throw new Error('Expected a JSON object');
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));
  const num = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
  const layers = Array.isArray(body.layers) ? body.layers.slice(0, 8).map((l) => ({ id: str(l.id, 32), name: str(l.name, 48), visible: !!l.visible, count: num(l.count) })) : [];
  const feeds = Array.isArray(body.feeds) ? body.feeds.slice(0, 8).map((f) => ({ id: str(f.id, 32), state: str(f.state, 24), detail: str(f.detail, 160) })) : [];
  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS).map((e) => ({ source: str(e.source, 32), time: str(e.time, 40), title: str(e.title, 160), subtitle: str(e.subtitle, 200) })) : [];
  const view = body.view && typeof body.view === 'object'
    ? { south: num(body.view.lamin), west: num(body.view.lomin), north: num(body.view.lamax), east: num(body.view.lomax) }
    : null;
  return { now: str(body.now, 40) ?? new Date().toISOString(), zoom: num(body.zoom), view, layers, feeds, events };
}

export function estimateCost(model, usage) {
  const p = PRICE[model];
  if (!p || !usage) return null;
  return ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output) / 1e6;
}

// A small token bucket so a public page can't run up a bill: one brief every
// `minGapMs`, at most `perHour` an hour, across all visitors.
export function createThrottle({ minGapMs = 5000, perHour = 20, now = Date.now } = {}) {
  let last = -Infinity;
  let stamps = [];
  return {
    take() {
      const t = now();
      stamps = stamps.filter((s) => t - s < 3_600_000);
      if (t - last < minGapMs) return { ok: false, retryAfterMs: minGapMs - (t - last), reason: 'A brief was just written; try again in a few seconds.' };
      if (stamps.length >= perHour) return { ok: false, retryAfterMs: 3_600_000 - (t - stamps[0]), reason: `The hourly limit of ${perHour} briefs is used up.` };
      last = t;
      stamps.push(t);
      return { ok: true };
    },
  };
}

// Default way to ask Claude: the official SDK, Messages API, one short reply.
// `system` is the prompt for the job (the brief here; server/describe.js has its own).
// `messages(input)` can turn the sanitised input into a short conversation instead.
export function sdkAsk({ apiKey, model, timeoutMs = 30_000, system = SYSTEM, label = 'Snapshot', messages }) {
  const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  const toMessages = messages ?? ((input) => [{ role: 'user', content: `${label}:\n${JSON.stringify(input)}` }]);
  return async (input) => {
    const response = await client.messages.create({
      model,
      max_tokens: 1024, // room for the reply; thinking is off so none is spent reasoning
      thinking: { type: 'disabled' },
      system,
      messages: toMessages(input),
    });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text, usage: response.usage, stopReason: response.stop_reason };
  };
}

// Express handler factory shared by every Claude-written route: the brief and the
// per-object description. `sanitize(body)` trims the request to what the prompt
// needs (and throws on junk); `ask(input)` resolves to { text, usage }; tests pass
// their own `ask`. The key stays on the server, and each route has a throttle.
export function createClaudeRoute({ name, system, label, messages, sanitize, apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.BRIEF_MODEL || DEFAULT_MODEL, ask, throttle = createThrottle() }) {
  const enabled = !!apiKey;
  const run = ask ?? (enabled ? sdkAsk({ apiKey, model, system, label, messages }) : null);
  async function handler(req, res) {
    if (!enabled) return res.status(404).json({ error: `${name} is off: no ANTHROPIC_API_KEY is set on the server.` });
    const gate = throttle.take();
    if (!gate.ok) {
      res.set('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)));
      return res.status(429).json({ error: gate.reason });
    }
    let input;
    try {
      input = sanitize(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      const { text, usage, stopReason } = await run(input);
      if (!text) return res.status(502).json({ error: 'Claude returned an empty reply.' });
      if (stopReason === 'max_tokens') console.warn(`[${name}] reply hit max_tokens; it may be cut short`);
      res.json({ text, model, usage, costUsd: estimateCost(model, usage), at: Date.now() });
    } catch (err) {
      const status = err?.status === 429 ? 429 : err?.status === 401 ? 502 : 502;
      const why = err?.status === 401 ? 'The ANTHROPIC_API_KEY on the server was rejected.' : err?.status === 429 ? 'Claude is rate limiting this app; try again shortly.' : `Claude could not be reached: ${err?.message ?? err}`;
      console.warn(`[${name}]`, err?.status ?? '', err?.message ?? err);
      res.status(status).json({ error: why });
    }
  }
  return { enabled, model, handler, bodyLimit: MAX_BODY };
}

export function createBriefRoute(options = {}) {
  return createClaudeRoute({ name: 'Briefs', system: SYSTEM, label: 'Snapshot', sanitize: sanitizeSnapshot, ...options });
}
