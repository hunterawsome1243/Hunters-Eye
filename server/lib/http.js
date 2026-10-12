export const USER_AGENT =
  process.env.USER_AGENT || 'HuntersEye/0.1 (+https://github.com/hunterawsome1243/Hunters-Eye)';

export class HttpError extends Error {
  constructor(status, message, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMs(res) {
  const header =
    res.headers.get('x-rate-limit-retry-after-seconds') ?? res.headers.get('retry-after');
  const sec = Number(header);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}

export async function request(url, { headers = {}, timeoutMs = 20000, ...opts } = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : err.cause?.code || err.message;
    throw new HttpError(0, `${new URL(url).host}: ${reason}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new HttpError(res.status, `${new URL(url).host} answered HTTP ${res.status}${body ? `: ${body}` : ''}`, retryAfterMs(res));
  }
  return res;
}

export async function getJson(url, opts) {
  return (await request(url, opts)).json();
}

export async function getText(url, opts) {
  return (await request(url, opts)).text();
}
