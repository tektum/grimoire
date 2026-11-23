import type { IdempotencyStore } from '../ports/idempotency-store.js';

/** In-memory IdempotencyStore for tests. A skeleton: the task T02 fills it in. */
export class FakeIdempotencyStore implements IdempotencyStore {}
