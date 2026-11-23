/** Raised when sibling ordering is asked for before an implementation is in place. A route answers 503 `unavailable`. */
export class OrderingNotAvailable extends Error {
  constructor() {
    super('sibling ordering is not available');
    this.name = 'OrderingNotAvailable';
  }
}

/** Sibling order as opaque text keys that compare in byte order (PostgreSQL `COLLATE "C"`). */
export interface Ordering {
  /** A key strictly between the two; `null` is an open end. */
  between(before: string | null, after: string | null): string;
  isValidPosition(key: string): boolean;
}

/** The ordering until the real one is composed: every call throws. */
export const unavailableOrdering: Ordering = {
  between() {
    throw new OrderingNotAvailable();
  },
  isValidPosition() {
    throw new OrderingNotAvailable();
  },
};
