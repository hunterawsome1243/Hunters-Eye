// Runs one data source on its own schedule and keeps the latest result in memory.
// Browsers only ever read from this cache, so the number of open tabs never changes
// how often an upstream API is called. Polling pauses when nobody has asked for data
// in a while, so an idle server spends none of a source's rate-limit budget.

export class SourcePoller {
  constructor(source, { idleMs = 10 * 60 * 1000, now = Date.now } = {}) {
    this.source = source;
    this.idleMs = idleMs;
    this.now = now;
    this.data = null;
    this.count = 0;
    this.updatedAt = null;
    this.lastAttempt = null;
    this.error = null;
    this.note = null;
    this.nextAt = null;
    this.lastRequested = 0;
    this.timer = null;
    this.inflight = null;
  }

  get intervalMs() {
    return typeof this.source.intervalMs === 'function' ? this.source.intervalMs() : this.source.intervalMs;
  }

  // Called whenever a browser asks for status or data. Wakes the poller if it slept.
  touch() {
    this.lastRequested = this.now();
    if (!this.timer && !this.inflight) this.schedule(0);
  }

  schedule(delayMs) {
    clearTimeout(this.timer);
    this.nextAt = this.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, delayMs);
    this.timer.unref?.();
  }

  run() {
    if (this.inflight) return this.inflight;
    if (this.now() - this.lastRequested > this.idleMs) {
      this.nextAt = null; // nobody is watching; wait for the next touch()
      return Promise.resolve();
    }
    this.inflight = this.poll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async poll() {
    this.lastAttempt = this.now();
    let delay = this.intervalMs;
    try {
      const result = await this.source.fetch({ previous: this.data });
      this.data = result.data;
      this.count = result.count ?? 0;
      this.note = result.note ?? null;
      this.updatedAt = result.updatedAt ?? this.now();
      this.error = null;
      if (result.nextDelayMs != null) delay = result.nextDelayMs;
    } catch (err) {
      this.error = err.message || String(err);
      delay = Math.max(this.source.errorRetryMs ?? delay, err.retryAfterMs || 0);
      console.warn(`[${this.source.id}] ${this.error}`);
    }
    this.schedule(delay);
  }

  status() {
    return {
      id: this.source.id,
      name: this.source.name,
      ok: !this.error && this.updatedAt !== null,
      loading: !this.error && this.updatedAt === null,
      error: this.error,
      note: this.note,
      count: this.count,
      updatedAt: this.updatedAt,
      lastAttempt: this.lastAttempt,
      nextAt: this.nextAt,
      intervalMs: this.intervalMs,
    };
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
