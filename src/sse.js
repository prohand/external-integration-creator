// -----------------------------------------------------------------------------
// Server-Sent Events, proxy friendly: no buffering (X-Accel-Buffering: no),
// no caching, a comment ping every 25 s so idle proxies keep the stream open.
// -----------------------------------------------------------------------------

export const PING_MS = 25_000;

export class Hub {
  constructor({ pingMs = PING_MS } = {}) {
    this.pingMs = pingMs;
    this.channels = new Map(); // channel -> Set<res>
    this.listeners = new Set(); // (channel, count) => void
  }

  /** Opens an SSE stream on `res` and subscribes it to `channel`. */
  open(req, res, channel, initial = []) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    res.write('retry: 5000\n\n');
    for (const { event, data } of initial) write(res, event, data);

    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(res);
    this.notify(channel);

    const ping = setInterval(() => res.write(': ping\n\n'), this.pingMs);
    const close = () => {
      clearInterval(ping);
      set.delete(res);
      if (!set.size) this.channels.delete(channel);
      this.notify(channel);
    };
    req.on('close', close);
    res.on('error', close);
  }

  publish(channel, event, data) {
    for (const res of this.channels.get(channel) ?? []) write(res, event, data);
  }

  count(channel) {
    return this.channels.get(channel)?.size ?? 0;
  }

  /** Called with (channel, count) whenever a client connects or leaves. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(channel) {
    for (const listener of this.listeners) listener(channel, this.count(channel));
  }

  closeAll() {
    for (const set of this.channels.values()) for (const res of set) res.end();
    this.channels.clear();
  }
}

function write(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
