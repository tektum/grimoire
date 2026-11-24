import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import pg from 'pg';
import type { GrimoireTables } from './schema.js';
import type { Database, Queryable } from '@tektum/grimoire-core/ports/database';
export * from './permissions.js';
export * from './users.js';
export * from './page-store.js';
export * from './schema.js';
export * from './idempotency.js';
export * from './collections.js';
export * from './audit.js';
export * from './pages.js';
export * from './trash.js';
export * from './revisions.js';
export * from './admin.js';
export * from './page-state.js';
export * from './attachments.js';
export * from './setup.js';

/** The port plus the Kysely handle, which only this package and the migration command use. */
export interface KyselyDatabase extends Database { readonly kysely: Kysely<GrimoireTables> }

export interface CreateDatabaseOptions {
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  /** Per-query limit for every query on this handle (pg `statement_timeout`, plus `query_timeout` 250 ms later as the guard for a server that does not answer). Unset: none. */
  readonly queryTimeoutMs?: number;
  /** `close()` stops waiting for a hung server after this long (default 1000); the sockets then die with the process. */
  readonly closeTimeoutMs?: number;
}

type Exec = Pick<Kysely<GrimoireTables>, 'executeQuery'>;

// The port speaks raw SQL with $n parameters, so queries go through CompiledQuery.raw; Kysely's builder stays inside this package.
const queryable = (k: Exec): Queryable => ({
  async query<Row>(sql: string, params: readonly unknown[] = []): Promise<readonly Row[]> {
    return (await k.executeQuery<Row>(CompiledQuery.raw(sql, [...params]))).rows;
  },
});

export function createDatabase(url: string, opts: CreateDatabaseOptions = {}): KyselyDatabase {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.maxConnections ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5000,
    ...(opts.queryTimeoutMs !== undefined ? { statement_timeout: opts.queryTimeoutMs, query_timeout: opts.queryTimeoutMs + 250 } : {}),
  });
  // Without a listener an idle-client error (server restart) would crash the process as an unhandled 'error' event.
  pool.on('error', () => undefined);
  const kysely = new Kysely<GrimoireTables>({ dialect: new PostgresDialect({ pool }) });
  const base = queryable(kysely);
  let closing: Promise<void> | undefined;
  return {
    kysely,
    query: base.query,
    transaction: (fn) => kysely.transaction().execute((trx) => fn(queryable(trx))),
    async ping() {
      await base.query('select 1');
    },
    close() {
      // destroy() ends the pg pool and waits for every connection to say goodbye, which a hung server never does; the race bounds it.
      closing ??= Promise.race([kysely.destroy(), new Promise<void>((resolve) => { setTimeout(resolve, opts.closeTimeoutMs ?? 1000).unref(); })]);
      return closing;
    },
  };
}

/** Raised when a migration fails or the migration history is inconsistent; the message names the migration. */
export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/**
 * Applies pending migrations from `dir` with Kysely's Migrator (file provider: `NNNN_name.ts|js` modules exporting `up`).
 * Forward-only: there is no down. A bad migration is corrected by a new, later migration.
 * Kysely wraps the batch in one transaction on PostgreSQL and holds its own advisory lock.
 */
export async function runMigrations(db: KyselyDatabase, dir: string): Promise<{ applied: string[] }> {
  const migrator = new Migrator({ db: db.kysely, provider: new FileMigrationProvider({ fs, path, migrationFolder: path.resolve(dir), import: loadMigrationFile }) });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (failed) throw new MigrationError(`migration ${failed.migrationName} failed: ${messageOf(error)}`, { cause: error });
  if (error) throw new MigrationError(messageOf(error), { cause: error });
  return { applied: (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName) };
}

// Wraps the provider's dynamic import: a syntax error from Node otherwise does not say which file it came from.
async function loadMigrationFile(file: string): Promise<unknown> {
  try {
    return await import(file);
  } catch (e) {
    throw new MigrationError(`cannot load migration file ${path.basename(file)}: ${messageOf(e)}`, { cause: e });
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
