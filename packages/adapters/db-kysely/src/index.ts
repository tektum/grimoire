import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import type { QueryResult } from 'kysely';
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
export * from './tenant-adopt.js';
export * from './search.js';
export * from './imports.js';
export * from './tenants.js';

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

/** A Kysely instance, a transaction or one connection of the pool: anything that runs a compiled query. */
interface Exec { executeQuery<R>(query: CompiledQuery<R>): Promise<QueryResult<R>> }

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

const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COMMIT = CompiledQuery.raw('commit');
const ROLLBACK = CompiledQuery.raw('rollback');

/** Raised by `scoped` for a tenant id that is not 1 to 128 letters, digits, "-" or "_": such an id never reaches SQL. */
export class TenantIdError extends Error {
  constructor() {
    super('a tenant id must be 1 to 128 letters, digits, "-" or "_"');
    this.name = 'TenantIdError';
  }
}

/** What `scoped` returns: the port's queries, each in a transaction with the tenant set. No `ping` or `close`: the pool belongs to the database it came from. */
export type TenantScoped = Pick<Database, 'query' | 'transaction'>;

/**
 * The runtime database for one tenant (docs/tenancy.md section 3.2): every `query` is one short transaction and every `transaction` sets the tenant first, with
 * `set_config('app.tenant', id, true)`. The setting is local to the transaction, so a pooled connection never carries a tenant into the next one. `begin` and the
 * setting go in one simple query (one round trip); that is why the id sits in the SQL text, and why only a validated id gets there.
 */
export function scoped(db: KyselyDatabase, tenantId: string): TenantScoped {
  if (!TENANT_ID.test(tenantId)) throw new TenantIdError();
  const begin = CompiledQuery.raw(`begin; select set_config('app.tenant', '${tenantId}', true)`);
  const transaction = <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => db.kysely.connection().execute(async (connection) => {
    try {
      await connection.executeQuery(begin);
      const result = await fn(queryable(connection));
      await connection.executeQuery(COMMIT);
      return result;
    } catch (error) {
      await connection.executeQuery(ROLLBACK).catch(() => undefined);
      throw error;
    }
  });
  return { query: (sql, params) => transaction((tx) => tx.query(sql, params)), transaction };
}

/**
 * The connection of the operator role `grimoire_ops` (docs/tenancy.md section 3.2), for the few call sites that cross tenants. It is not a `Database` nor a
 * `Queryable` (it has no `query`) and neither is one of those an `OperatorDatabase` (no `kind`), so the compiler keeps the two apart. Only the modules listed in
 * tools/ci/operator-sites.mjs may use it; `bun run lint` checks that.
 */
export interface OperatorDatabase {
  readonly kind: 'operator';
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A small pool of its own (4 connections unless told otherwise) over `GRIMOIRE_DATABASE_OPS_URL`; never the runtime pool. */
export function createOpsDatabase(url: string, opts: CreateDatabaseOptions = {}): OperatorDatabase {
  const db = createDatabase(url, { maxConnections: 4, ...opts });
  return { kind: 'operator', transaction: db.transaction, close: db.close };
}

/** The operator connection, which is undefined where `GRIMOIRE_DATABASE_OPS_URL` is not set: then this refuses, and nothing falls back to the runtime pool. */
export function operator(ops: OperatorDatabase | undefined): OperatorDatabase {
  if (ops === undefined) throw new Error('the operator connection is not configured: set GRIMOIRE_DATABASE_OPS_URL');
  return ops;
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

/** What the migration lock needs of a connection: a query, and an end that lets go of every lock the session holds. */
export interface LockClient {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

async function connectForLock(connectionString: string): Promise<LockClient> {
  const client = new pg.Client({ connectionString });
  // An idle connection the server drops (a restart, a network blip) would otherwise be an unhandled error that ends the process in the middle of a migration. The loss costs
  // this extra lock only: Kysely's own lock, held on the migrations' connection, still serialises the schema changes.
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/**
 * Runs `run` while holding a Postgres session lock that only one migration holds at a time: a second `migrate` (a second task starting during a deploy) waits for the first
 * and then finds nothing left to do, instead of racing it. It covers the whole command (Kysely's migrations, the job queue's schema and the grants, which have their own,
 * narrower locks or none) and uses its own connection, so the one the migrations use is free for them. The lock goes with the connection, so a crashed worker never leaves it held.
 */
export async function withMigrationLock<T>(connectionString: string, run: () => Promise<T>, connect: (url: string) => Promise<LockClient> = connectForLock): Promise<T> {
  const client = await connect(connectionString);
  try {
    await client.query(`select pg_advisory_lock(hashtext('grimoire.migrate'))`);
    try {
      return await run();
    } finally {
      // Letting go is best effort: it must not replace the error of the migration, and the lock goes with the connection anyway.
      await client.query(`select pg_advisory_unlock(hashtext('grimoire.migrate'))`).catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
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
