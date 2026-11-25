import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userStoreCapCases } from '@tektum/grimoire-core/testing/user-store-cap-conformance';
import { createUserStore } from '../../src/users.js';
import { createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

// docs/tenancy.md section 3.8: a new person of a tenant at its cap of people is refused; the count and the insert run under a per-tenant lock.
let t: TestDatabase;
const person = (n: string, tenant?: string) => ({ descopeUserId: `cap-${n}`, email: `${n}@cap.test`, name: n, role: 'member' as const, ...(tenant === undefined ? {} : { tenant: { id: tenant, name: 'cap.test' } }) });
const count = async (tenant: string) => Number((await t.admin.query<{ n: string }>(`select count(*)::text as n from users where tenant_id = $1`, [tenant]))[0]?.n);

beforeAll(async () => { t = await createTestDatabase('usercap'); }, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the cap of people of a tenant', () => {
  it('makes people up to the cap, refuses the next one with tenant-full and writes nothing, and still returns an existing person', async () => {
    const users = createUserStore(t.app, t.ops, 2);
    expect(await users.createIfAbsent(person('a1', 'T-cap'))).toMatchObject({ kind: 'created', user: { tenantId: 'T-cap' } });
    expect(await users.createIfAbsent(person('a2', 'T-cap'))).toMatchObject({ kind: 'created', user: { tenantId: 'T-cap' } });
    expect(await users.createIfAbsent(person('a3', 'T-cap'))).toEqual({ kind: 'tenant-full' });
    expect(await count('T-cap')).toBe(2);
    expect(await users.findByDescopeId('cap-a3')).toBeUndefined();
    expect(await users.createIfAbsent(person('a1', 'T-cap'))).toMatchObject({ kind: 'existing', user: { descopeUserId: 'cap-a1' } });
  });

  it('does not count the people of another tenant, and counts legacy for a person who names no tenant', async () => {
    const users = createUserStore(t.app, t.ops, 1);
    expect(await users.createIfAbsent(person('b1', 'T-b'))).toMatchObject({ kind: 'created', user: { tenantId: 'T-b' } });
    expect(await users.createIfAbsent(person('c1', 'T-c'))).toMatchObject({ kind: 'created', user: { tenantId: 'T-c' } });
    expect(await users.createIfAbsent(person('b2', 'T-b'))).toEqual({ kind: 'tenant-full' });
    // legacy already holds the system user of the migrations: it counts like any row.
    const legacy = await count('legacy');
    expect(await createUserStore(t.app, t.ops, legacy).createIfAbsent(person('l1'))).toEqual({ kind: 'tenant-full' });
    expect(await createUserStore(t.app, t.ops, legacy + 1).createIfAbsent(person('l1'))).toMatchObject({ kind: 'created', user: { tenantId: 'legacy' } });
  });

  it('never passes the cap when first sign-ins of one tenant run at once', async () => {
    const users = createUserStore(t.app, t.ops, 4);
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => users.createIfAbsent(person(`p${String(n)}`, 'T-race'))));
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(4);
    expect(results.filter((r) => r.kind === 'tenant-full')).toHaveLength(1);
    expect(await count('T-race')).toBe(4);
  });
});

describe('the order in which a new person is judged (the cases every store agrees on)', () => {
  it.each(userStoreCapCases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    await c.run({ store: createUserStore(t.app, t.ops, 2), tenant: `T-order-${String(Math.random()).slice(2, 10)}` });
  });
});
