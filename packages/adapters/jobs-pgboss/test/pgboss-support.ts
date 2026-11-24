import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { Database, Queryable } from '@tektum/grimoire-core/ports/database';
import type { JobQueue } from '@tektum/grimoire-core/ports/job-queue';
import { adminUrl } from '@tektum/grimoire-test-support/database';
import { PGBOSS_SCHEMA, createJobQueue, type PgBossJobQueue } from '../src/index.js';

// Runs against the Compose PostgreSQL (`make db-up`), in a database of its own that the test drops afterwards.

export function databaseUrl(name: string): string {
  return adminUrl(name);
}

export async function createTestDatabase(name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl('postgres') });
  await client.connect();
  try {
    await client.query(`drop database if exists ${name} with (force)`);
    await client.query(`create database ${name}`);
  } finally {
    await client.end();
  }
}

export async function dropTestDatabase(name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl('postgres') });
  await client.connect();
  try {
    await client.query(`drop database if exists ${name} with (force)`);
  } finally {
    await client.end();
  }
}

/** Installs pg-boss's own schema the way the library does it itself; the migrate command does this in production. */
export async function installPgBoss(url: string): Promise<void> {
  const boss = new PgBoss({ connectionString: url, schema: PGBOSS_SCHEMA });
  await boss.start();
  await boss.stop({ graceful: true, close: true, timeout: 2000 });
}

/** A small pool-backed Database (the Kysely adapter is not a dependency of this package). */
export function poolDatabase(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const run = (q: pg.Pool | pg.PoolClient): Queryable => ({
    query: async <Row>(sql: string, params: readonly unknown[] = []) => (await q.query(sql, [...params])).rows as Row[],
  });
  return {
    ...run(pool),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const value = await fn(run(client));
        await client.query('commit');
        return value;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async ping() { await pool.query('select 1'); },
    async close() { await pool.end(); },
  };
}

/** A queue with quick supervision, so a crashed worker's job comes back within seconds. */
export function startQueue(url: string): Promise<PgBossJobQueue> {
  return createJobQueue({ connectionString: url, max: 4, cron: true, onError: () => undefined }, (o) => new PgBoss({ ...o, superviseIntervalSeconds: 5 }));
}

export type { JobQueue };
