import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import { grantRuntimeRole, migratePgBoss, requireSchemaAccess } from '../src/migrate.js';

const functions = ['create_queue', 'delete_queue', 'job_table_run', 'job_now'];

function recorder(tables: string[], access: { owns: boolean | null; can_create?: boolean } = { owns: true }) {
  const sql: string[] = [];
  const db: Queryable = {
    query: async <Row>(text: string) => {
      sql.push(text.replace(/\s+/g, ' ').trim());
      if (text.includes('current_user')) return [{ me: 'grimoire_migrator', can_create: false, ...access }] as Row[];
      if (text.includes('pg_proc')) return functions.map((name) => ({ signature: `pgboss.${name}(text)`, name })) as Row[];
      return (text.includes('pg_class') ? tables.map((name) => ({ name })) : []) as Row[];
    },
  };
  return { db, sql };
}

describe('grantRuntimeRole', () => {
  it('grants table by table (partitions included) from the tables found, select and update only on the version table', async () => {
    const { db, sql } = recorder(['bam', 'job', 'queue', 'version']);
    expect(await grantRuntimeRole(db, 'grimoire_app')).toEqual(['bam', 'job', 'queue', 'version']);
    expect(sql).toContain('grant usage on schema "pgboss" to "grimoire_app"');
    expect(sql).toContain('grant select, insert, update, delete on table "pgboss"."job" to "grimoire_app"');
    expect(sql).toContain('grant select, update on table "pgboss"."version" to "grimoire_app"');
    expect(sql).toContain('grant usage, select on all sequences in schema "pgboss" to "grimoire_app"');
    expect(sql).toContain('grant execute on function pgboss.job_now(text) to "grimoire_app"');
    expect(sql).toContain('revoke execute on function pgboss.job_table_run(text) from "grimoire_app"');
    expect(sql).toContain('revoke execute on function pgboss.create_queue(text) from public');
    expect(sql).toContain('revoke execute on function pgboss.create_queue(text) from "grimoire_app"');
    expect(sql).toContain('revoke execute on function pgboss.delete_queue(text) from "grimoire_app"');
    expect(sql.some((q) => q.startsWith('grant execute') && /create_queue|delete_queue|job_table_run/.test(q))).toBe(false);
    expect(sql).toContain('grant select, update on table "pgboss"."queue" to "grimoire_app"');
    expect(sql.slice(-2)).toEqual([
      'alter default privileges in schema "pgboss" grant select, insert, update, delete on tables to "grimoire_app"',
      'alter default privileges in schema "pgboss" grant usage, select on sequences to "grimoire_app"',
    ]);
  });

  it('refuses a role or table name that is not a plain identifier', async () => {
    await expect(grantRuntimeRole(recorder([]).db, 'x"; drop table y; --')).rejects.toThrow(/not a plain/);
    await expect(grantRuntimeRole(recorder(['Bad Name']).db, 'grimoire_app')).rejects.toThrow(/not a plain/);
  });

  it('is repeatable and picks up what appeared since: every statement is an idempotent grant or revoke, and a new table is granted too', async () => {
    const first = recorder(['job']);
    const second = recorder(['job', 'j0a1b2c3']); // a queue partition made between the two runs
    await grantRuntimeRole(first.db, 'grimoire_app');
    await grantRuntimeRole(second.db, 'grimoire_app');
    const writes = (sql: string[]) => sql.filter((q) => !q.startsWith('select'));
    for (const q of [...writes(first.sql), ...writes(second.sql)]) expect(q).toMatch(/^(grant|revoke|alter default privileges) /);
    for (const q of writes(first.sql)) expect(second.sql).toContain(q);
    expect(second.sql).toContain('grant select, insert, update, delete on table "pgboss"."j0a1b2c3" to "grimoire_app"');
    expect(first.sql).not.toContain('grant select, insert, update, delete on table "pgboss"."j0a1b2c3" to "grimoire_app"');
  });

  it('takes execute away before it gives the role access to the schema', async () => {
    const { db, sql } = recorder(['job']);
    await grantRuntimeRole(db, 'grimoire_app');
    const usage = sql.indexOf('grant usage on schema "pgboss" to "grimoire_app"');
    expect(usage).toBeGreaterThan(sql.indexOf('revoke execute on function pgboss.create_queue(text) from "grimoire_app"'));
    expect(usage).toBeGreaterThan(sql.indexOf('revoke execute on function pgboss.job_now(text) from public'));
  });
});

describe('migratePgBoss', () => {
  function boss() {
    const handlers: Record<string, (e: Error) => void> = {};
    const b = {
      start: vi.fn(async () => b),
      stop: vi.fn(async () => {}),
      getQueue: vi.fn<(name: string) => Promise<unknown>>(async () => null),
      createQueue: vi.fn(async () => {}),
      on: vi.fn((event: string, fn: (e: Error) => void) => { handlers[event] = fn; return b; }),
    };
    return { b, handlers };
  }

  it('runs the library migration with the migration connection, then grants', async () => {
    const { b } = boss();
    const make = vi.fn(() => b);
    const { db, sql } = recorder(['job']);
    expect(await migratePgBoss({ connectionString: 'postgresql://example/db', database: db, runtimeRole: 'grimoire_app', make: make as never })).toEqual(['job']);
    expect(make).toHaveBeenCalledWith({ connectionString: 'postgresql://example/db', schema: 'pgboss', migrate: true, createSchema: false, supervise: false, schedule: false, registerInstance: false });
    expect(b.stop).toHaveBeenCalledWith({ graceful: true, close: true, timeout: 2000 });
    expect(sql.some((q) => q.startsWith('grant select, insert'))).toBe(true);
  });

  it('creates the queues in order after the migration and before the grants, leaving an existing one alone', async () => {
    const { b } = boss();
    const order: string[] = [];
    b.start.mockImplementation((async () => { order.push('start'); return b; }) as never);
    b.createQueue.mockImplementation((async (name: string) => { order.push(`create ${name}`); }) as never);
    b.getQueue.mockImplementation((async (name: string) => (name === 'old' ? { policy: 'standard' } : null)) as never);
    const { db, sql } = recorder(['job']);
    const q = (name: string) => ({ name, policy: 'standard', retryLimit: 1, retryDelaySeconds: 1, retryBackoff: false, expireInSeconds: 60, retentionSeconds: 60 }) as const;
    await migratePgBoss({ connectionString: 'postgresql://example/db', database: db, runtimeRole: 'grimoire_app', make: (() => b) as never, queues: [q('first'), q('old'), q('second')] });
    expect(order).toEqual(['start', 'create first', 'create second']);
    expect(sql.findIndex((s) => s.startsWith('grant select, insert'))).toBeGreaterThan(-1);
    expect(b.stop).toHaveBeenCalledTimes(1);
  });

  it('closes pg-boss when a queue cannot be created, and grants nothing', async () => {
    const { b } = boss();
    b.createQueue.mockRejectedValueOnce(new Error('no rights'));
    const { db, sql } = recorder(['job']);
    const queues = [{ name: 'x', policy: 'standard', retryLimit: 1, retryDelaySeconds: 1, retryBackoff: false, expireInSeconds: 60, retentionSeconds: 60 }] as const;
    await expect(migratePgBoss({ connectionString: 'postgresql://example/db', database: db, runtimeRole: 'grimoire_app', make: (() => b) as never, queues })).rejects.toThrow('no rights');
    expect(b.stop).toHaveBeenCalledTimes(1);
    expect(sql.filter((s) => s.startsWith('grant'))).toEqual([]);
  });

  it('fails, and grants nothing, when pg-boss reported an error during the migration', async () => {
    const { b, handlers } = boss();
    b.start.mockImplementation((async () => { handlers.error?.(new Error('migration broke')); return b; }) as never);
    const { db, sql } = recorder(['job']);
    await expect(migratePgBoss({ connectionString: 'postgresql://example/db', database: db, runtimeRole: 'grimoire_app', make: (() => b) as never })).rejects.toThrow('migration broke');
    expect(sql.filter((q) => q.startsWith('grant'))).toEqual([]);
  });

  it('builds a real PgBoss by default', async () => {
    const { db } = recorder([]);
    await expect(migratePgBoss({ connectionString: 'postgresql://127.0.0.1:1/none', database: db, runtimeRole: 'grimoire_app' })).rejects.toThrow();
  });
});

describe('migratePgBoss, a queue made with another policy', () => {
  const def = (name: string, policy: 'stately' | 'singleton') => ({ name, policy, retryLimit: 1, retryDelaySeconds: 1, retryBackoff: false, expireInSeconds: 60, retentionSeconds: 60 }) as const;
  function run(existing: Record<string, string>, jobs: Record<string, number>) {
    const calls: string[] = [];
    const b = {
      start: vi.fn(async () => b), stop: vi.fn(async () => {}), on: vi.fn(() => b),
      getQueue: vi.fn(async (name: string) => (name in existing ? { policy: existing[name] } : null)),
      createQueue: vi.fn(async (name: string) => { calls.push(`create ${name}`); }),
      deleteQueue: vi.fn(async (name: string) => { calls.push(`delete ${name}`); }),
    };
    const base = recorder(['job']).db;
    const db: Queryable = {
      query: async <Row>(text: string, params: readonly unknown[] = []) =>
        (text.includes('pgboss.job') && text.includes('group by state') ? Object.entries(jobs).map(([state, count]) => ({ state, count })) : base.query<Row>(text, params)) as Promise<Row[]>,
    };
    const dropped: unknown[] = [];
    const go = (queues: ReturnType<typeof def>[]) => migratePgBoss({ connectionString: 'postgresql://example/db', database: db, runtimeRole: 'grimoire_app', make: (() => b) as never, queues, onQueueRecreated: (e) => dropped.push(e) });
    return { b, calls, dropped, go };
  }

  it('recreates it when it holds only created and retry jobs (and finished ones), and says what it dropped', async () => {
    const { calls, dropped, go } = run({ purge: 'singleton' }, { created: 1, retry: 2, completed: 5 });
    await go([def('purge', 'stately')]);
    expect(calls).toEqual(['delete purge', 'create purge']);
    expect(dropped).toEqual([{ queue: 'purge', from: 'singleton', to: 'stately', pending: 3, finished: 5 }]);
  });

  it('refuses, naming the queue, when a job is active, and changes nothing', async () => {
    const { calls, dropped, go, b } = run({ purge: 'singleton' }, { created: 1, active: 1 });
    await expect(go([def('purge', 'stately')])).rejects.toThrow(/purge.*active/);
    expect(calls).toEqual([]);
    expect(dropped).toEqual([]);
    expect(b.stop).toHaveBeenCalledTimes(1);
  });

  it('reads a queue that reports no policy as standard, the library default', async () => {
    const { b, calls, dropped, go } = run({}, {});
    b.getQueue.mockResolvedValue({} as never);
    await go([def('purge', 'stately')]);
    expect(calls).toEqual(['delete purge', 'create purge']);
    expect(dropped).toMatchObject([{ from: 'standard' }]);
  });

  it('leaves a queue of the wanted policy alone, and recreates an empty one without reporting a loss', async () => {
    const same = run({ purge: 'stately' }, { created: 4 });
    await same.go([def('purge', 'stately')]);
    expect(same.calls).toEqual([]);
    const empty = run({ purge: 'singleton' }, {});
    await empty.go([def('purge', 'stately')]);
    expect(empty.calls).toEqual(['delete purge', 'create purge']);
    expect(empty.dropped).toEqual([{ queue: 'purge', from: 'singleton', to: 'stately', pending: 0, finished: 0 }]);
  });
});

describe('requireSchemaAccess', () => {
  it('passes when the migration role owns the schema', async () => {
    await requireSchemaAccess(recorder([], { owns: true }).db);
  });

  it('creates the schema itself when it is missing and the role may create schemas', async () => {
    const { db, sql } = recorder([], { owns: null, can_create: true });
    await requireSchemaAccess(db);
    expect(sql.at(-1)).toBe('create schema if not exists "pgboss"');
  });

  it('names a create statement when the schema is missing and cannot be created', async () => {
    await expect(requireSchemaAccess(recorder([], { owns: null }).db)).rejects.toThrow('create schema pgboss authorization grimoire_migrator;');
  });

  it('names an alter statement, not a create, when someone else owns the schema', async () => {
    const error = await requireSchemaAccess(recorder([], { owns: false }).db).then(() => undefined, (e: Error) => e);
    expect(error?.message).toContain('alter schema pgboss owner to grimoire_migrator;');
    expect(error?.message).not.toContain('create schema');
  });

  it('stops migratePgBoss before pg-boss starts', async () => {
    const make = vi.fn();
    await expect(migratePgBoss({ connectionString: 'postgresql://example/db', database: recorder([], { owns: null }).db, runtimeRole: 'grimoire_app', make: make as never })).rejects.toThrow(/must exist and be owned/);
    expect(make).not.toHaveBeenCalled();
  });

  it('still names a fix when the check returns no row', async () => {
    const empty = { query: async () => [] } as never;
    await expect(requireSchemaAccess(empty)).rejects.toThrow(/authorization the migration role;/);
  });
});
