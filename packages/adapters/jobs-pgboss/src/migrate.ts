import { PgBoss, type ConstructorOptions } from 'pg-boss';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { QueueDefinition } from '@tektum/grimoire-core/ports/job-queue';
import { PGBOSS_SCHEMA, queueOptions } from './index.js';

/**
 * What the runtime role may do on a pg-boss table: read and write, except `version`, a single-row table whose timestamp
 * columns (`maintained_on`, `cron_on`, ...) the maintenance and cron loops update to take their turn. No insert or delete there.
 */
const TABLE_PRIVILEGES: ReadonlyMap<string, string> = new Map([
  ['version', 'select, update'],
  // Queues are made and dropped by the migration role; the runtime role only reads them and updates their statistics.
  ['queue', 'select, update'],
]);

/**
 * Functions the runtime role must not run: they create or drop queues (`create_queue`, `delete_queue`) or run a command string
 * against the job tables (`job_table_run`, `job_table_run_async`, `job_table_format`), which only the library's migrations call.
 * Any other function in the schema it may run.
 */
const DDL_FUNCTIONS: ReadonlySet<string> = new Set(['create_queue', 'delete_queue', 'job_table_format', 'job_table_run', 'job_table_run_async']);

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
  /** Queues to create (in this order) after the migration and before the grants, so the runtime role gets their partitions. */
  readonly queues?: readonly QueueDefinition[];
  /** Test seam: builds the PgBoss that runs the library's own migration. */
  readonly make?: (options: ConstructorOptions) => Pick<PgBoss, 'start' | 'stop' | 'on' | 'getQueue' | 'createQueue' | 'deleteQueue'>;
  /** Called for each queue that was recreated because it had another policy: pg-boss cannot change a policy, and the scheduled queues keep no state worth keeping (they are sent again at start). */
  readonly onQueueRecreated?: (e: { readonly queue: string; readonly from: string; readonly to: string; readonly pending: number; readonly finished: number }) => void;
}

/**
 * A queue found with another policy than the definition's is deleted and created again, unless a job of it is running: then it is left and the migration stops
 * with the queue's name. Created and retry jobs go with it (the scheduler sends the next run at start), as do finished ones; the counts are reported.
 */
async function reconcileQueue(boss: Pick<PgBoss, 'getQueue' | 'createQueue' | 'deleteQueue'>, db: Queryable, definition: QueueDefinition, options: MigrateOptions): Promise<void> {
  const existing = await boss.getQueue(definition.name);
  if (existing === null) return boss.createQueue(definition.name, queueOptions(definition));
  const from = existing.policy ?? 'standard';
  if (from === definition.policy) return;
  const rows = await db.query<{ state: string; count: number }>(`select state::text as state, count(*)::int as count from ${PGBOSS_SCHEMA}.job where name = $1 group by state`, [definition.name]);
  const count = (...states: string[]): number => rows.filter((r) => states.includes(r.state)).reduce((sum, r) => sum + r.count, 0);
  if (count('active') > 0) throw new Error(`queue ${definition.name} has policy ${from}, the definition says ${definition.policy}, and a job of it is active: stop the running servers, then run the migration again`);
  await boss.deleteQueue(definition.name);
  await boss.createQueue(definition.name, queueOptions(definition));
  options.onQueueRecreated?.({ queue: definition.name, from, to: definition.policy, pending: count('created', 'retry'), finished: count('completed', 'cancelled', 'failed') });
}

/**
 * Installs or upgrades pg-boss's schema with the migration role, creates the queues, then grants the runtime role what each table
 * needs. The table list is read from the schema after the migration, because the library's list is not verified.
 * Safe to run again: the library's migration is a no-op when current, and GRANT is idempotent.
 * Partitions are included: the common job partition is written directly. Objects the migration role creates later get default privileges. Returns the tables it granted on, in order.
 */
export async function migratePgBoss(options: MigrateOptions): Promise<readonly string[]> {
  await requireSchemaAccess(options.database);
  const make = options.make ?? ((o: ConstructorOptions) => new PgBoss(o));
  const boss = make({ connectionString: options.connectionString, schema: PGBOSS_SCHEMA, migrate: true, createSchema: false, supervise: false, schedule: false, registerInstance: false });
  let failure: Error | undefined;
  boss.on('error', (e: Error) => { failure = e; });
  await boss.start();
  try {
    for (const queue of options.queues ?? []) await reconcileQueue(boss, options.database, queue, options);
  } finally {
    await boss.stop({ graceful: true, close: true, timeout: 2000 });
  }
  if (failure) throw failure;
  return grantRuntimeRole(options.database, options.runtimeRole);
}

/**
 * The schema must exist and belong to the migration role before the library runs. The library is told not to create
 * it (`createSchema: false`): the schema is pre-created for the migration role (db/init/roles.psql), which therefore
 * needs no CREATE on the database. A role that does have that privilege (a database it owns) creates the schema here.
 * Anything else fails early with the statement that fixes it, instead of a bare "permission denied".
 */
export async function requireSchemaAccess(db: Queryable, schema: string = PGBOSS_SCHEMA): Promise<void> {
  const [row] = await db.query<{ me: string; can_create: boolean; owns: boolean | null }>(
    `select current_user::text as me, has_database_privilege(current_user, current_database(), 'create') as can_create,
            (select pg_has_role(current_user, nspowner, 'usage') from pg_namespace where nspname = $1) as owns`,
    [schema],
  );
  if (row?.owns === true) return;
  if (row?.owns === null && row.can_create) {
    await db.query(`create schema if not exists ${ident(schema)}`);
    return;
  }
  const who = row?.me ?? 'the migration role';
  const fix = row?.owns === false ? `alter schema ${schema} owner to ${who};` : `create schema ${schema} authorization ${who};`;
  throw new Error(`the "${schema}" schema must exist and be owned by the migration role: run once, as a role that may: ${fix}`);
}

export async function grantRuntimeRole(db: Queryable, role: string, schema: string = PGBOSS_SCHEMA): Promise<readonly string[]> {
  const s = ident(schema);
  const r = ident(role);
  // Functions first: they carry EXECUTE for PUBLIC by default, so each is revoked from PUBLIC (and the DDL ones from the runtime
  // role) before the role is given any access to the schema, and the allowed ones are granted back one by one.
  const functions = await db.query<{ signature: string; name: string }>(
    `select p.oid::regprocedure::text as signature, p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1 order by 1`,
    [schema],
  );
  for (const f of functions) {
    await db.query(`revoke execute on function ${f.signature} from public`);
    if (DDL_FUNCTIONS.has(f.name)) await db.query(`revoke execute on function ${f.signature} from ${r}`);
  }
  await db.query(`grant usage on schema ${s} to ${r}`);
  for (const f of functions) if (!DDL_FUNCTIONS.has(f.name)) await db.query(`grant execute on function ${f.signature} to ${r}`);
  const tables = await db.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'p') order by c.relname`,
    [schema],
  );
  const granted: string[] = [];
  for (const { name } of tables) {
    const privileges = TABLE_PRIVILEGES.get(name) ?? 'select, insert, update, delete';
    await db.query(`grant ${privileges} on table ${s}.${ident(name)} to ${r}`);
    granted.push(name);
  }
  await db.query(`grant usage, select on all sequences in schema ${s} to ${r}`);
  // Tables and sequences the migration role creates later get the same rights. In practice that is a queue's partition, made when
  // the migration role creates the queue. Functions get no default: a function added by a later pg-boss version is revoked from
  // PUBLIC and judged by the loop above the next time this step runs (it runs on every `grimoire migrate`).
  await db.query(`alter default privileges in schema ${s} grant select, insert, update, delete on tables to ${r}`);
  await db.query(`alter default privileges in schema ${s} grant usage, select on sequences to ${r}`);
  return granted;
}
