import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import { grantRuntimeRole, migratePgBoss } from '../src/migrate.js';

function recorder(tables: string[]) {
  const sql: string[] = [];
  const db: Queryable = {
    query: async <Row>(text: string) => {
      sql.push(text.replace(/\s+/g, ' ').trim());
      return (text.includes('pg_class') ? tables.map((name) => ({ name })) : []) as Row[];
    },
  };
  return { db, sql };
}

describe('grantRuntimeRole', () => {
  it('grants table by table from the tables found, read-only for the version table', async () => {
    const { db, sql } = recorder(['bam', 'job', 'version']);
    expect(await grantRuntimeRole(db, 'grimoire_app')).toEqual(['bam', 'job', 'version']);
    expect(sql).toContain('grant usage on schema "pgboss" to "grimoire_app"');
    expect(sql).toContain('grant select, insert, update, delete on table "pgboss"."job" to "grimoire_app"');
    expect(sql).toContain('grant select on table "pgboss"."version" to "grimoire_app"');
    expect(sql.at(-2)).toBe('grant usage, select on all sequences in schema "pgboss" to "grimoire_app"');
    expect(sql.at(-1)).toBe('grant execute on all functions in schema "pgboss" to "grimoire_app"');
  });

  it('refuses a role or table name that is not a plain identifier', async () => {
    await expect(grantRuntimeRole(recorder([]).db, 'x"; drop table y; --')).rejects.toThrow(/not a plain/);
    await expect(grantRuntimeRole(recorder(['Bad Name']).db, 'grimoire_app')).rejects.toThrow(/not a plain/);
  });

  it('is repeatable: a second run issues the same statements', async () => {
    const first = recorder(['job']);
    const second = recorder(['job']);
    await grantRuntimeRole(first.db, 'grimoire_app');
    await grantRuntimeRole(second.db, 'grimoire_app');
    expect(second.sql).toEqual(first.sql);
  });
});

describe('migratePgBoss', () => {
  function boss() {
    const handlers: Record<string, (e: Error) => void> = {};
    const b = {
      start: vi.fn(async () => b),
      stop: vi.fn(async () => {}),
      on: vi.fn((event: string, fn: (e: Error) => void) => { handlers[event] = fn; return b; }),
    };
    return { b, handlers };
  }

  it('runs the library migration with the migration connection, then grants', async () => {
    const { b } = boss();
    const make = vi.fn(() => b);
    const { db, sql } = recorder(['job']);
    expect(await migratePgBoss({ connectionString: 'postgresql://example/db', database: db, runtimeRole: 'grimoire_app', make: make as never })).toEqual(['job']);
    expect(make).toHaveBeenCalledWith({ connectionString: 'postgresql://example/db', schema: 'pgboss', migrate: true, supervise: false, schedule: false, registerInstance: false });
    expect(b.stop).toHaveBeenCalledWith({ graceful: true, close: true, timeout: 2000 });
    expect(sql.some((q) => q.startsWith('grant select, insert'))).toBe(true);
  });

  it('fails, and grants nothing, when pg-boss reported an error during the migration', async () => {
    const { b, handlers } = boss();
    b.start.mockImplementation((async () => { handlers.error?.(new Error('migration broke')); return b; }) as never);
    const { db, sql } = recorder(['job']);
    await expect(migratePgBoss({ connectionString: 'postgresql://example/db', database: db, runtimeRole: 'grimoire_app', make: (() => b) as never })).rejects.toThrow('migration broke');
    expect(sql).toEqual([]);
  });

  it('builds a real PgBoss by default', async () => {
    const { db } = recorder([]);
    await expect(migratePgBoss({ connectionString: 'postgresql://127.0.0.1:1/none', database: db, runtimeRole: 'grimoire_app' })).rejects.toThrow();
  });
});
