import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// The sampled clean-up of `idempotency_keys` deletes by age; without this index each run scans the whole table. Raw SQL, as in 0001 to 0006.
// Forward-only: 0005 is merged and never edited. Grants are unchanged (the table keeps the ones 0005 gave `grimoire_app`).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create index idempotency_keys_created_idx on idempotency_keys (created_at)`.execute(db);
}
