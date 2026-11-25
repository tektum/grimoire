import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as kysely from 'kysely';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import { accessCases, collectionExpectOf, worldOfCases } from '@tektum/grimoire-core/testing/access-cases';
import { createFakeAccessStore } from '@tektum/grimoire-core/testing/fake-access-store';
import type { AccessStore } from '@tektum/grimoire-core/ports/access-store';
import * as handles from '../../src/index.js';
import { createDatabase } from '../../src/index.js';
import type { KyselyDatabase } from '../../src/index.js';
import { createAccessStore } from '../../src/permissions.js';
import { createMigratedDatabase, dropDatabase, loadTenantWorld, loadWorld, tenantFailures, urlFor } from './support.js';

// Mutation check of the SQL form: the real source with one change, loaded from a scratch copy, must fail the shared table (or the list form).
const UNFILED = '00000000-0000-4000-8000-000000000002';
const DB = `grimoire_m3t04_mut_${String(process.pid)}`;
const SRC = fileURLToPath(new URL('../../src/permissions.ts', import.meta.url));
const { world, ids } = worldOfCases();
let db: KyselyDatabase;
let owner: KyselyDatabase; // the schema owner: row-level security does not apply to it

async function failures(store: AccessStore): Promise<number> {
  const a = createAuthorizer(store);
  const fake = createAuthorizer(createFakeAccessStore(world));
  let bad = 0;
  for (const [i, c] of accessCases.entries()) {
    const id = ids[i];
    if (!id) { bad++; continue; }
    const d = await a.check({ tenantId: 'legacy', userId: id.userId, pageId: id.pageId }, { includeDeleted: c.includeDeleted });
    if ((d.access === 'none' ? d.reason : d.access) !== c.expect) bad++;
    if (collectionExpectOf(c) !== 'skip') {
      const k = await a.checkCollection({ tenantId: 'legacy', userId: id.userId, collectionId: id.collectionId }, { includeDeleted: c.includeDeleted });
      if ((k.access === 'none' ? k.reason : k.access) !== collectionExpectOf(c)) bad++;
    }
    const listed = (await a.visibleCollections('legacy', id.userId, { includeDeleted: c.includeDeleted })).filter((r) => r.collectionId !== UNFILED); // the migration's own collection is not in the table's world
    if (JSON.stringify(listed) !== JSON.stringify(await fake.visibleCollections('legacy', id.userId, { includeDeleted: c.includeDeleted }))) bad++;
  }
  return bad;
}

/** Compiles the real source with the edits applied and evaluates it as CommonJS; its only runtime import is kysely. */
function mutant(name: string, edits: readonly (readonly [string, string])[], on: KyselyDatabase = db): AccessStore {
  let source = readFileSync(SRC, 'utf8');
  for (const [from, to] of edits) {
    if (!source.includes(from)) throw new Error(`mutant ${name}: the text to change is gone`);
    source = source.replaceAll(from, to);
  }
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const fn: unknown = runInThisContext(`(function (module, exports, require) {${js}\n})`, { filename: `mutant-${name}.js` });
  const mod: { exports: { createAccessStore?: typeof createAccessStore } } = { exports: {} };
  // Its runtime imports: kysely, and `scoped` from the package's own index.
  Reflect.apply(fn as (...a: unknown[]) => unknown, undefined, [mod, mod.exports, (id: string) => (id === 'kysely' ? kysely : id === './index.js' ? handles : {})]);
  if (!mod.exports.createAccessStore) throw new Error(`mutant ${name}: no createAccessStore`);
  return mod.exports.createAccessStore(on);
}

beforeAll(async () => {
  await createMigratedDatabase(DB);
  await loadWorld(DB, world);
  await loadTenantWorld(DB);
  db = createDatabase(urlFor('grimoire_app', DB));
  owner = createDatabase(urlFor('grimoire_migrator', DB));
}, 180_000);
afterAll(async () => {
  await db.close();
  await owner.close();
  await dropDatabase(DB);
});

describe('SQL mutants', () => {
  it('the unmutated SQL passes', async () => {
    expect(await failures(createAccessStore(db))).toBe(0);
  });
  it('group entries ignored in the SQL fails the table', async () => {
    const store = mutant('groups', [
      ['union all\n    select ca.permission from group_members gm join collection_access ca on ca.collection_id = ${sql.ref(collectionId)} and ca.group_id = gm.group_id where gm.user_id = ${sql.ref(userId)}\n', ''],
      ['union all\n          select ca.permission from group_members gm join collection_access ca on ca.collection_id = c.id and ca.group_id = gm.group_id where gm.user_id = u.id\n', ''],
    ]);
    expect(await failures(store)).toBeGreaterThan(0);
  });
  it('the collection deleted flag ignored in collectionFacts fails the table', async () => {
    const store = mutant('deleted', [['collection: { deleted: row.collection_deleted_at !== null', 'collection: { deleted: false']]);
    expect(await failures(store)).toBeGreaterThan(0);
  });
  it('the unmutated SQL passes the two-tenant check, under the policies and without them (the explicit conditions are enough on their own)', async () => {
    expect(await tenantFailures(createAccessStore(db))).toBe(0);
    expect(await tenantFailures(createAccessStore(owner))).toBe(0);
  });
  // The tenant mutants run as the schema owner, which row-level security does not apply to: under the policies of the runtime role the other tenant's rows are hidden whatever the SQL says, and
  // the mutant would pass. This keeps the check on the SQL's own conditions, the primary protection (docs/tenancy.md section 3.2).
  it('the tenant condition removed from visibleCollections fails the two-tenant check (an admin would list another tenant\'s collections)', async () => {
    const store = mutant('tenant-list', [["          .whereRef('c.tenant_id', '=', 'u.tenant_id') // a collection of another tenant is not there (docs/tenancy.md, 3.3)\n", '']], owner);
    expect(await tenantFailures(store)).toBeGreaterThan(0);
  });
  it('the page\'s tenant left out of facts fails the two-tenant check', async () => {
    const store = mutant('tenant-page', [['...(row.page_tenant === null ? {} : { tenantId: row.page_tenant }), ', '']], owner);
    expect(await tenantFailures(store)).toBeGreaterThan(0);
  });
  it('the collection\'s tenant left out of collectionFacts fails the two-tenant check', async () => {
    const store = mutant('tenant-collection', [['...(row.collection_tenant === null ? {} : { tenantId: row.collection_tenant }), ', '']], owner);
    expect(await tenantFailures(store)).toBeGreaterThan(0);
  });
  it('the user\'s tenant left out of the facts fails the two-tenant check', async () => {
    const store = mutant('tenant-user', [[", ...(r.user_tenant === null ? {} : { tenantId: r.user_tenant })", '']], owner);
    expect(await tenantFailures(store)).toBeGreaterThan(0);
  });
  it('the viewer cap removed from visibleCollections fails the list form', async () => {
    const store = mutant('viewer', [['least(1, v.best)', 'v.best']]);
    expect(await failures(store)).toBeGreaterThan(0);
  });
});
