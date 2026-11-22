import { Kysely } from 'kysely';

/** Deliberately failing module, outside db/migrations and test globs. */
export async function up(db: Kysely<unknown>): Promise<void> {
  void db;
  throw new Error('deliberate startup migration failure');
}
