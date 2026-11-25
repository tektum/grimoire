/** Waits for a share of a rate: the embedding jobs take their chunks from it, so the model's thread never runs flat out (`GRIMOIRE_SEMANTIC_MAX_CHUNKS_PER_MINUTE`). */
export interface RateLimiter {
  /** Resolves when `n` units may be used. Rejects when the sleep does (an aborted signal). */
  acquire(n: number, signal: AbortSignal): Promise<void>;
}

export interface RateLimiterOptions {
  readonly perMinute: number;
  /** Most that can be stored up while idle, and the size of the largest request that waits for less than it asks. Default 16 (a batch). */
  readonly capacity?: number;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * A token bucket that starts empty: a request takes what it needs once that much has accrued, so the first minute holds no more than `perMinute` units, and a quiet
 * time refills only up to `capacity` (it does not store up a burst).
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const perMs = options.perMinute / 60_000;
  const capacity = options.capacity ?? 16;
  let tokens = 0;
  let last = options.now();
  return {
    async acquire(n, signal) {
      const need = Math.max(n, capacity);
      for (;;) {
        const now = options.now();
        tokens = Math.min(need, tokens + (now - last) * perMs);
        last = now;
        if (tokens >= n) {
          tokens -= n;
          return;
        }
        await options.sleep(Math.ceil((n - tokens) / perMs), signal);
      }
    },
  };
}

/** The real sleep: a timer that does not keep the process alive and ends early, rejecting, when the signal aborts. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    timer.unref();
    const onAbort = (): void => { clearTimeout(timer); reject(new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
