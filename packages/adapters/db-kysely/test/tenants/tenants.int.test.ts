import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenants } from '../../src/tenants.js';
import { createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase('tenants'); }, 60_000);
afterAll(async () => { await t?.drop(); });

describe('createTenants', () => {
  it('lists every tenant, oldest first', async () => {
    await t.admin.query(`insert into tenants (id, name, created_at) values ('T-b', 'b', now() + interval '1 second'), ('T-a', 'a', now() + interval '2 seconds')`);
    expect(await createTenants(t.ops).ids()).toEqual(['legacy', 'T-b', 'T-a']);
  });
});
