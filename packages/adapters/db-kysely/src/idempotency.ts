import type { ClaimResult, IdempotencyStore, StoredResponse } from '@tektum/grimoire-core/ports/idempotency-store';
import type { KyselyDatabase, OperatorDatabase } from './index.js';

interface Existing { same: boolean; status: number | null; response: unknown }

/**
 * The PostgreSQL IdempotencyStore over `idempotency_keys` (primary key `(user_id, key)`): every statement is one indexed lookup or insert.
 * A key is stored in the tenant of its user (legacy for a user the database does not know). The clean-up of old keys spans every tenant: it runs on `ops`,
 * the operator connection (docs/tenancy.md section 3.2).
 */
export function createIdempotency(db: KyselyDatabase, ops: OperatorDatabase): IdempotencyStore {
  return {
    async claim(userId, key, requestHash): Promise<ClaimResult> {
      const inserted = await db.query<{ one: number }>(
        `insert into idempotency_keys (user_id, key, request_hash, tenant_id)
         values ($1, $2, decode($3, 'hex'), coalesce((select tenant_id from users where id = $1), 'legacy'))
         on conflict (user_id, key) do nothing returning 1 as one`,
        [userId, key, requestHash],
      );
      if (inserted.length > 0) return { kind: 'claimed' };
      const rows = await db.query<Existing>(
        `select request_hash = decode($3, 'hex') as same, status, response from idempotency_keys where user_id = $1 and key = $2`,
        [userId, key, requestHash],
      );
      const row = rows[0];
      // The row can vanish between the two statements (a release or the cleanup): the caller is then simply refused and may retry.
      if (row === undefined || !row.same || row.status === null) return { kind: 'conflict' };
      return { kind: 'replay', response: { status: row.status, body: row.response } };
    },
    async complete(userId, key, response: StoredResponse): Promise<void> {
      await db.query(
        `update idempotency_keys set status = $3, response = $4::jsonb where user_id = $1 and key = $2`,
        [userId, key, response.status, JSON.stringify(response.body)],
      );
    },
    async release(userId, key): Promise<void> {
      await db.query(`delete from idempotency_keys where user_id = $1 and key = $2 and status is null`, [userId, key]);
    },
    async deleteCreatedBefore(cutoffMs): Promise<number> {
      const rows = await ops.transaction((tx) => tx.query<{ one: number }>(`delete from idempotency_keys where created_at < to_timestamp($1::double precision / 1000.0) returning 1 as one`, [cutoffMs]));
      return rows.length;
    },
  };
}
