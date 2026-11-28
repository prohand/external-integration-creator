// -----------------------------------------------------------------------------
// Failure counter against guessing: per key (an address, an account) and
// globally, over a sliding window. Memory stays bounded.
// -----------------------------------------------------------------------------

export const AUTH_LIMITS = {
  window: 15 * 60_000, // failures are counted over 15 minutes
  perKey: 10, // then that address (or account) is blocked until the window ends
  global: 100, // and every address is slowed down past this many failures
  maxTracked: 10_000, // keys remembered at most (oldest dropped first)
};

export function createLimiter({ limits = AUTH_LIMITS, now = () => Date.now() } = {}) {
  const failures = new Map(); // key -> { count, since }
  let global = { count: 0, since: now() };

  const fresh = (key, t) => {
    const entry = failures.get(key);
    if (entry && t - entry.since > limits.window) failures.delete(key);
    return failures.get(key);
  };

  return {
    /** True when `key` (or everybody, past the global limit) must wait. */
    blocked(key, { perKey = limits.perKey, useGlobal = true } = {}) {
      const t = now();
      if (t - global.since > limits.window) global = { count: 0, since: t };
      if ((fresh(key, t)?.count ?? 0) >= perKey) return true;
      return useGlobal && global.count >= limits.global;
    },
    fail(key, { useGlobal = true } = {}) {
      const t = now();
      if (useGlobal) global.count += 1;
      const current = fresh(key, t) ?? { count: 0, since: t };
      current.count += 1;
      failures.delete(key);
      failures.set(key, current);
      if (failures.size > limits.maxTracked) {
        for (const [k, e] of failures) if (t - e.since > limits.window) failures.delete(k);
        while (failures.size > limits.maxTracked) failures.delete(failures.keys().next().value);
      }
    },
    success(key) {
      failures.delete(key);
    },
    /** Remaining wait for `key`, in minutes (rounded up). */
    waitMinutes(key) {
      const entry = failures.get(key);
      const end = (entry?.since ?? global.since) + limits.window;
      return Math.max(1, Math.ceil((end - now()) / 60_000));
    },
    tracked: () => failures.size,
    reset() {
      failures.clear();
      global = { count: 0, since: now() };
    },
  };
}
