import type { ClaimResult, IdempotencyStore, StoredResponse } from '@tektum/grimoire-core/ports/idempotency-store';
import { scoped } from './index.js';
import type { KyselyDatabase, OperatorDatabase } from './index.js';

interface Existing { same: boolean; status: number | null; response: unknown }

/**
 * The PostgreSQL IdempotencyStore over `idempotency_keys` (primary key `(user_id, key)`): every statement is one indexed lookup or insert. A key is
 * stored in the caller's tenant, and every statement of a request runs scoped to it. The clean-up of old keys spans every tenant: it runs on `ops`,
 * the operator connection (docs/tenancy.md section 3.2).
 */
export function createIdempotency(db: KyselyDatabase, ops: OperatorDatabase): IdempotencyStore {
  return {
    claim(tenantId, userId, key, requestHash): Promise<ClaimResult> {
      return scoped(db, tenantId).transaction(async (tx): Promise<ClaimResult> => {
        const inserted = await tx.query<{ one: number }>(
          `insert into idempotency_keys (user_id, key, request_hash, tenant_id) values ($1, $2, decode($3, 'hex'), $4)
           on conflict (user_id, key) do nothing returning 1 as one`,
          [userId, key, requestHash, tenantId],
        );
        if (inserted.length > 0) return { kind: 'claimed' };
        const rows = await tx.query<Existing>(
          `select request_hash = decode($3, 'hex') as same, status, response from idempotency_keys where user_id = $1 and key = $2 and tenant_id = $4`,
          [userId, key, requestHash, tenantId],
        );
        const row = rows[0];
        // The row can vanish between the two statements (a release or the cleanup): the caller is then simply refused and may retry.
        if (row === undefined || !row.same || row.status === null) return { kind: 'conflict' };
        return { kind: 'replay', response: { status: row.status, body: row.response } };
      });
    },
    async complete(tenantId, userId, key, response: StoredResponse): Promise<void> {
      await scoped(db, tenantId).query(
        `update idempotency_keys set status = $3, response = $4::jsonb where user_id = $1 and key = $2 and tenant_id = $5`,
        [userId, key, response.status, JSON.stringify(response.body), tenantId],
      );
    },
    async release(tenantId, userId, key): Promise<void> {
      await scoped(db, tenantId).query(`delete from idempotency_keys where user_id = $1 and key = $2 and status is null and tenant_id = $3`, [userId, key, tenantId]);
    },
    async deleteCreatedBefore(cutoffMs): Promise<number> {
      const rows = await ops.transaction((tx) => tx.query<{ one: number }>(`delete from idempotency_keys where created_at < to_timestamp($1::double precision / 1000.0) returning 1 as one`, [cutoffMs]));
      return rows.length;
    },
  };
}
