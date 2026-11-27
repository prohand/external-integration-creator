// -----------------------------------------------------------------------------
// In-memory cache with a TTL. Concurrent callers share the same pending load,
// and the last good value is kept when a refresh fails (served as "stale").
// -----------------------------------------------------------------------------

export class Cache {
  constructor(ttlMs, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  /**
   * Returns { value, fetchedAt, stale, error } for `key`, loading it with
   * `loader` when missing or expired.
   */
  async get(key, loader, { force = false } = {}) {
    const entry = this.entries.get(key);
    const fresh = entry?.value !== undefined && this.now() - entry.fetchedAt < this.ttlMs;
    if (fresh && !force) {
      return { value: entry.value, fetchedAt: entry.fetchedAt, stale: false, error: null };
    }
    if (entry?.pending) {
      return entry.pending;
    }
    const pending = (async () => {
      try {
        const value = await loader();
        const fetchedAt = this.now();
        this.entries.set(key, { value, fetchedAt });
        return { value, fetchedAt, stale: false, error: null };
      } catch (error) {
        if (entry?.value !== undefined) {
          this.entries.set(key, { value: entry.value, fetchedAt: entry.fetchedAt });
          return { value: entry.value, fetchedAt: entry.fetchedAt, stale: true, error };
        }
        this.entries.delete(key);
        throw error;
      }
    })();
    this.entries.set(key, { ...entry, pending });
    return pending;
  }

  clear(key) {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}
