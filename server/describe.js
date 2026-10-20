import { createClaudeRoute, createThrottle } from './brief.js';

// "Describe": a short plain-language description of one object the user clicked
// on the globe (a quake, a plane, a satellite, an alert), written by Claude on
// demand. The browser sends what the detail card already shows (kind, heading,
// the label/value rows, the note, the link); this server adds the key and asks
// the API. Same key, throttle shape and pricing as the situation brief
// (server/brief.js): about 600 tokens in and 150 out, roughly $0.0001 a press.

const MAX_FIELDS = 16;

const SYSTEM = `You explain one object shown on "Hunter's Eye", a public dashboard that shows live earthquakes (USGS), aircraft positions (OpenSky Network), satellites (CelesTrak orbital elements) and US severe weather alerts (National Weather Service) on a 3D globe.
You get a JSON record of the object the user clicked: its kind, heading, the fields the dashboard shows for it, and sometimes a note. Write what a knowledgeable colleague would say about it in plain English.
Rules:
- 60 to 110 words, as 2 or 3 short paragraphs. No headings, no bullet lists, no markdown.
- Start with what the object is and why it matters (or doesn't): how strong, how high, how fast, how severe, how unusual, in everyday terms a non-specialist understands.
- Add the general knowledge that helps read the fields: what a magnitude or depth means for what people felt, what a squawk code or an altitude band means, what kind of satellite this is and what it does, what an alert of this type asks people to do. Keep it general and well known; never invent specifics about this particular object.
- Use only the record for the object's own facts. Do not guess causes, names, operators, routes or outcomes the record does not contain. If a field says "—" or is missing, leave it out.
- Times in the record are what the dashboard shows; refer to them as given.
- A follow-up question may come after your description. Answer it in 40 to 90 words under the same rules. If it is not about this object or the kind of thing it is, say in one sentence that you can only talk about what is on the globe.`;

// The request as a short conversation: the object, then (for a follow-up) the last
// answer and the question. Only the last answer is carried, so a thread never grows.
export function toMessages({ question, previous, ...object }) {
  const messages = [{ role: 'user', content: `Object:\n${JSON.stringify(object)}` }];
  if (question) {
    if (previous) messages.push({ role: 'assistant', content: previous });
    messages.push({ role: 'user', content: `Follow-up question: ${question}` });
  }
  return messages;
}

// Trims the browser's record to what the prompt needs and caps every size.
export function sanitizeItem(body) {
  if (!body || typeof body !== 'object') throw new Error('Expected a JSON object');
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));
  const kind = str(body.kind, 32);
  const heading = str(body.heading, 160);
  if (!kind || !heading) throw new Error('Expected an object with a kind and a heading');
  const fields = Array.isArray(body.fields)
    ? body.fields.slice(0, MAX_FIELDS)
      .filter((f) => f && typeof f === 'object')
      .map((f) => ({ label: str(f.label, 40), value: str(f.value, 160), sub: str(f.sub, 80) }))
      .filter((f) => f.label && f.value)
    : [];
  const out = { kind, heading, fields, notes: str(body.notes, 300), link: str(body.link, 200) };
  const question = str(body.question, 300)?.trim();
  if (question) {
    out.question = question;
    out.previous = str(body.previous, 1200)?.trim() || null;
  }
  return out;
}

export function createDescribeRoute(options = {}) {
  return createClaudeRoute({ name: 'Descriptions', system: SYSTEM, messages: toMessages, sanitize: sanitizeItem, throttle: createThrottle({ noun: 'description' }), ...options });
}
