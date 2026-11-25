import { describe, expect, it } from 'vitest';
import type { Database, Queryable } from '@tektum/grimoire-core/ports/database';
import { operator, scoped, TenantIdError } from '../src/index.js';
import type { KyselyDatabase, OperatorDatabase } from '../src/index.js';

// docs/tenancy.md section 3.2, step 1: the tenant goes into a SQL literal, so only an id that needs no quoting gets there, and the operator handle is a type of its own.
const untouchable = new Proxy({}, { get: () => { throw new Error('the database was touched'); } }) as KyselyDatabase;

describe('scoped', () => {
  it.each(['', "a'b", 'a;b', 'a b', 'tenant\n', 'x'.repeat(129), 'é', '$1'])('refuses the tenant id %j before anything reaches the database', (id) => {
    expect(() => scoped(untouchable, id)).toThrow(TenantIdError);
  });

  it('takes letters, digits, "-" and "_", up to 128 of them', () => {
    for (const id of ['legacy', 'a-B_9', 'x'.repeat(128)]) expect(() => scoped(untouchable, id)).not.toThrow();
  });
});

describe('the operator handle', () => {
  it('is absent unless configured, and asking for it then says which setting is missing', () => {
    expect(() => operator(undefined)).toThrow(/GRIMOIRE_DATABASE_OPS_URL/);
  });

  it('is what was configured', () => {
    const ops = { kind: 'operator', transaction: () => Promise.reject(new Error('unused')), close: () => Promise.resolve() } as OperatorDatabase;
    expect(operator(ops)).toBe(ops);
  });

  it('is a type of its own: the compiler keeps it and the runtime database apart (checked by `bun run typecheck`)', () => {
    const opsIsNotQueryable: [OperatorDatabase] extends [Queryable] ? false : true = true;
    const opsIsNotRuntime: [OperatorDatabase] extends [Database] ? false : true = true;
    const runtimeIsNotOps: [Database] extends [OperatorDatabase] ? false : true = true;
    const kyselyIsNotOps: [KyselyDatabase] extends [OperatorDatabase] ? false : true = true;
    expect([opsIsNotQueryable, opsIsNotRuntime, runtimeIsNotOps, kyselyIsNotOps]).toEqual([true, true, true, true]);
  });
});
