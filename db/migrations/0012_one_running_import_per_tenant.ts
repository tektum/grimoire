import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// A workspace has one running import at a time (M7 decision 6). The database holds the rule, so that two starts at once cannot both win: a second `running` row of one
// tenant is refused by this index, and the repository answers it as `ImportBusyError`: the second import waits as `uploaded` and its job tries again. A partial unique index, forward-only; no row has to change (no import runs before this).
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create unique index imports_one_running_per_tenant on imports (tenant_id) where status = 'running'`.execute(db);
}
