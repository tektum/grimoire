import type { IdempotencyStore } from '@tektum/grimoire-core/ports/idempotency-store';
import type { KyselyDatabase } from './index.js';

/** The PostgreSQL IdempotencyStore. A skeleton: the owning task fills it in with the typed handle. */
export function createIdempotency(db: KyselyDatabase): IdempotencyStore {
  void db; // the owning task reads from it
  return {};
}
