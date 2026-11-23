import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// 0004 gave `pages.collection_id` and `pages.created_by` defaults (the unfiled collection and the system user) so that rows written before
// collections existed could be given a home. Every writer now names both, so the defaults go: a page insert that forgets one is refused
// (NOT NULL) instead of landing in the unfiled collection as a system page. `url_id` and `position` keep their defaults.
// Forward-only: 0004 is merged and never edited.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table pages alter column collection_id drop default, alter column created_by drop default`.execute(db);
}
