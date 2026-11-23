import { PgBoss, type ConstructorOptions } from 'pg-boss';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import { PGBOSS_SCHEMA } from './index.js';

/** What the runtime role may do on a pg-boss table; every table not named here is read and written. */
const READ_ONLY_TABLES: ReadonlySet<string> = new Set(['version']);

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`not a plain lower-case identifier: ${name}`);
  return `"${name}"`;
}

export interface MigrateOptions {
  /** Connection string of the migration role (it creates and changes the pgboss schema). */
  readonly connectionString: string;
  /** The migration role's database, used for the grants. */
  readonly database: Queryable;
  /** The role the server runs as. */
  readonly runtimeRole: string;
  /** Test seam: builds the PgBoss that runs the library's own migration. */
  readonly make?: (options: ConstructorOptions) => Pick<PgBoss, 'start' | 'stop' | 'on'>;
}

/**
 * Installs or upgrades pg-boss's schema with the migration role, then grants the runtime role what each table
 * needs. The table list is read from the schema after the migration, because the library's list is not verified.
 * Safe to run again: the library's migration is a no-op when current, and GRANT is idempotent.
 * Returns the tables it granted on, in order.
 */
export async function migratePgBoss(options: MigrateOptions): Promise<readonly string[]> {
  const make = options.make ?? ((o: ConstructorOptions) => new PgBoss(o));
  const boss = make({ connectionString: options.connectionString, schema: PGBOSS_SCHEMA, migrate: true, supervise: false, schedule: false, registerInstance: false });
  let failure: Error | undefined;
  boss.on('error', (e: Error) => { failure = e; });
  await boss.start();
  await boss.stop({ graceful: true, close: true, timeout: 2000 });
  if (failure) throw failure;
  return grantRuntimeRole(options.database, options.runtimeRole);
}

export async function grantRuntimeRole(db: Queryable, role: string, schema: string = PGBOSS_SCHEMA): Promise<readonly string[]> {
  const s = ident(schema);
  const r = ident(role);
  await db.query(`grant usage on schema ${s} to ${r}`);
  const tables = await db.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'p') and not c.relispartition order by c.relname`,
    [schema],
  );
  const granted: string[] = [];
  for (const { name } of tables) {
    const privileges = READ_ONLY_TABLES.has(name) ? 'select' : 'select, insert, update, delete';
    await db.query(`grant ${privileges} on table ${s}.${ident(name)} to ${r}`);
    granted.push(name);
  }
  await db.query(`grant usage, select on all sequences in schema ${s} to ${r}`);
  await db.query(`grant execute on all functions in schema ${s} to ${r}`);
  return granted;
}
