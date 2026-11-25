import type { ClaimResult, IdempotencyStore, StoredResponse } from '../ports/idempotency-store.js';
import type { Clock } from '../ports/clock.js';

interface Row { readonly hash: string; readonly createdAt: number; response?: StoredResponse }

/** In-memory IdempotencyStore for tests; the same rules as the PostgreSQL one. */
export class FakeIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, Row>();

  constructor(private readonly clock: Clock = { now: () => Date.now() }) {}

  private static key(tenantId: string, userId: string, key: string): string {
    return JSON.stringify([tenantId, userId, key]);
  }

  claim(tenantId: string, userId: string, key: string, requestHash: string): Promise<ClaimResult> {
    const id = FakeIdempotencyStore.key(tenantId, userId, key);
    const row = this.rows.get(id);
    if (row === undefined) {
      this.rows.set(id, { hash: requestHash, createdAt: this.clock.now() });
      return Promise.resolve({ kind: 'claimed' });
    }
    if (row.hash !== requestHash || row.response === undefined) return Promise.resolve({ kind: 'conflict' });
    return Promise.resolve({ kind: 'replay', response: row.response });
  }

  complete(tenantId: string, userId: string, key: string, response: StoredResponse): Promise<void> {
    const row = this.rows.get(FakeIdempotencyStore.key(tenantId, userId, key));
    if (row !== undefined) row.response = response;
    return Promise.resolve();
  }

  release(tenantId: string, userId: string, key: string): Promise<void> {
    const id = FakeIdempotencyStore.key(tenantId, userId, key);
    if (this.rows.get(id)?.response === undefined) this.rows.delete(id);
    return Promise.resolve();
  }

  deleteCreatedBefore(cutoffMs: number): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.createdAt < cutoffMs) { this.rows.delete(id); removed += 1; }
    }
    return Promise.resolve(removed);
  }

  /** Test view: how many rows exist. */
  get size(): number {
    return this.rows.size;
  }
}
