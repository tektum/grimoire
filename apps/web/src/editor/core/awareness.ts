/**
 * The awareness the editor publishes through. The server guarantees only `user.id` of what a client publishes, so the client publishes only
 * `{ user: { id }, cursor, blockId }` (never a name or a colour), and at most four updates a second however often the selection moves.
 * Everything else the editor tries to write is dropped. Updates are coalesced: the newest value of each field is what is sent.
 */
export interface AwarenessLike {
  getLocalState(): Record<string, unknown> | null;
  setLocalState(state: Record<string, unknown> | null): void;
  setLocalStateField(field: string, value: unknown): void;
}

export interface PresenceTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: PresenceTimers = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Four updates a second. */
export const PRESENCE_INTERVAL_MS = 250;
export const PUBLISHED_FIELDS: readonly string[] = ['user', 'cursor', 'blockId'];

export interface PresenceOptions {
  /** The signed-in person's id, or null while it is not known (then `user` is not published, and the server's own `user.id` stands). */
  readonly userId: () => string | null;
  readonly timers?: PresenceTimers;
  readonly intervalMs?: number;
}

export function presenceAwareness<A extends AwarenessLike>(awareness: A, options: PresenceOptions): A {
  const timers = options.timers ?? realTimers;
  const interval = options.intervalMs ?? PRESENCE_INTERVAL_MS;
  let pending: Record<string, unknown> = {};
  let lastSent = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;

  const send = (): void => {
    timer = null;
    if (Object.keys(pending).length === 0) return;
    const next = { ...(awareness.getLocalState() ?? {}), ...pending };
    // The id is added to whatever goes out once it is known, so a person whose id arrived after the editor is still identified by the first move.
    const id = options.userId();
    if (id !== null) next['user'] = { id };
    pending = {};
    lastSent = timers.now();
    awareness.setLocalState(next); // one update for everything that changed since the last one
  };
  const schedule = (): void => {
    if (timer !== null) return;
    const wait = lastSent + interval - timers.now();
    if (wait <= 0) send();
    else timer = timers.setTimeout(send, wait);
  };
  const write = (field: string, value: unknown): void => {
    if (!PUBLISHED_FIELDS.includes(field)) return;
    if (field === 'user') {
      const id = options.userId();
      if (id === null) return;
      pending['user'] = { id }; // whatever the editor passes, only the id goes out
    } else pending[field] = value;
    schedule();
  };

  const overrides: Record<string | symbol, unknown> = {
    setLocalStateField: (field: string, value: unknown) => write(field, value),
    setLocalState: (state: Record<string, unknown> | null) => {
      if (state === null) {
        // Leaving: sent at once, and nothing that was waiting is sent after it.
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
        pending = {};
        awareness.setLocalState(null);
        return;
      }
      for (const field of PUBLISHED_FIELDS) if (field in state) write(field, state[field]);
    },
    // What the editor reads back includes what is still waiting, so it does not compare with an older value and write the same thing again.
    getLocalState: () => {
      const current = awareness.getLocalState();
      return current === null && Object.keys(pending).length === 0 ? null : { ...(current ?? {}), ...pending };
    },
    destroy: () => {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      pending = {};
      (awareness as unknown as { destroy(): void }).destroy();
    },
  };
  return new Proxy(awareness, {
    get(target, property) {
      if (property in overrides) return overrides[property];
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
