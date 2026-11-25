import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// The vector of a chunk is kept in the row, not in the TOAST table beside it (M7-T14). A 768-dimension vector is 3 KB, over the 2 KB at which Postgres moves a value out of line, so by default every
// vector sat in TOAST and each search read 140,000 of them one by one: measured on 140,000 chunks, the semantic statement took 335 to 372 ms and with the vector in the row 109 ms
// (docs/proof/m7-hybrid-search.md). `main` keeps a value in the row (compressed first if it must be); a value that cannot fit a page still goes out of line, which a 3 KB vector never does.
// The setting applies to a value written after it, and no chunk is written before this migration (the jobs that write them arrive with it), so there is nothing to rewrite; a database that has
// chunks from before it would keep their out-of-line copies until they are written again.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table page_chunks alter column embedding set storage main`.execute(db);
}
