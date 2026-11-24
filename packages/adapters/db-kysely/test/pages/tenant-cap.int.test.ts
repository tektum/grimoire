import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatePageResult, TenantPageLimits } from '@tektum/grimoire-core/ports/page-repo';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { createPages } from '../../src/pages.js';
import { createTrash } from '../../src/trash.js';
import { addTenant, addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

// docs/tenancy.md section 3.8: the open pages of a tenant (not in the trash) are capped; a create or a restore past the cap is refused, counted under a per-tenant lock.
const ordering = new FakeOrdering();
const cap = (maxTenantPages: number): TenantPageLimits => ({ maxDepth: 32, maxPages: 10_000, maxTenantPages });
const place = (before: string | null, after: string | null) => ordering.between(before, after);
let t: TestDatabase;
const pages = () => createPages(t.app);
const trash = () => createTrash(t.app);

/** A tenant with a person and `n` collections. */
async function tenant(id: string, n = 1): Promise<{ by: string; collections: string[] }> {
  await addTenant(t.app, id);
  const by = await addUser(t.app, `boss-${id}`, 'admin', id);
  const collections: string[] = [];
  for (let i = 0; i < n; i += 1) collections.push((await createCollections(t.app).append(id, { name: `Docs ${String(i)}`, createdBy: by }, (last) => ordering.between(last, null))).id);
  return { by, collections };
}
const make = (tenantId: string, collectionId: string, by: string, limits: TenantPageLimits, parentId: string | null = null): Promise<CreatePageResult> =>
  pages().create(tenantId, { collectionId, parentId, afterId: null, title: 'Page', createdBy: by }, limits, place);
async function made(result: Promise<CreatePageResult>): Promise<string> {
  const r = await result;
  if (r.kind !== 'created') throw new Error(r.kind);
  return r.page.id;
}
const open = async (tenantId: string) => Number((await t.admin.query<{ n: string }>(`select count(*)::text as n from pages where tenant_id = $1 and deleted_at is null`, [tenantId]))[0]?.n);

beforeAll(async () => { t = await createTestDatabase('pagecap'); }, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the cap of open pages of a tenant', () => {
  it('creates pages up to the cap across the collections of the tenant, then refuses with tenant-pages-full and writes nothing', async () => {
    const a = await tenant('T-full', 2);
    const [one, two] = a.collections as [string, string];
    await made(make('T-full', one, a.by, cap(3)));
    await made(make('T-full', one, a.by, cap(3)));
    await made(make('T-full', two, a.by, cap(3)));
    expect(await make('T-full', two, a.by, cap(3))).toEqual({ kind: 'tenant-pages-full' });
    expect(await open('T-full')).toBe(3);
    expect(await make('T-full', two, a.by, cap(4))).toMatchObject({ kind: 'created' });
  });

  it('does not count the pages in the trash, nor the pages of another tenant', async () => {
    const a = await tenant('T-trash');
    const b = await tenant('T-other');
    const [collection] = a.collections as [string];
    const first = await made(make('T-trash', collection, a.by, cap(2)));
    await made(make('T-trash', collection, a.by, cap(2)));
    expect(await make('T-trash', collection, a.by, cap(2))).toEqual({ kind: 'tenant-pages-full' });
    expect(await make('T-other', b.collections[0] as string, b.by, cap(2))).toMatchObject({ kind: 'created' });
    expect(await pages().softDelete('T-trash', first, a.by, collection)).toMatchObject({ kind: 'deleted' });
    expect(await make('T-trash', collection, a.by, cap(2))).toMatchObject({ kind: 'created' });
  });

  it('refuses a restore whose batch would pass the cap and leaves it in the trash, and restores it when it fits', async () => {
    const a = await tenant('T-restore');
    const [collection] = a.collections as [string];
    const parent = await made(make('T-restore', collection, a.by, cap(3)));
    await made(make('T-restore', collection, a.by, cap(3), parent));
    await made(make('T-restore', collection, a.by, cap(3)));
    expect(await pages().softDelete('T-restore', parent, a.by, collection)).toEqual({ kind: 'deleted', pages: 2 });
    await made(make('T-restore', collection, a.by, cap(3)));
    expect(await trash().restore('T-restore', parent, collection, cap(3), place)).toEqual({ kind: 'tenant-pages-full' });
    expect(await trash().rootOf('T-restore', parent)).toMatchObject({ id: parent });
    expect(await open('T-restore')).toBe(2);
    expect(await trash().restore('T-restore', parent, collection, cap(4), place)).toMatchObject({ kind: 'restored' });
    expect(await open('T-restore')).toBe(4);
  });

  it('never passes the cap when creates in several collections of one tenant run at once', async () => {
    const a = await tenant('T-race', 5);
    const results = await Promise.all(a.collections.map((collection) => make('T-race', collection, a.by, cap(4))));
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(4);
    expect(results.filter((r) => r.kind === 'tenant-pages-full')).toHaveLength(1);
    expect(await open('T-race')).toBe(4);
  });
});
