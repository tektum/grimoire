import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { insertCollection, insertPage, insertUser, SYSTEM_USER_ID, UNFILED_COLLECTION_ID } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dropTestDatabase, migratorUrl, repoRoot, requireBuild, runToEnd, serverDir, sqlAdmin } from '../../server/support/harness.js';

// Migration 0009, tenancy (docs/tenancy.md sections 3.1 and 5): the `tenants` table, `tenant_id` on every tenant table, the `legacy` backfill, the composite keys that keep a row in
// the tenant of its parents, and the per-tenant unique indexes. On an empty database and on one at 0008 that holds rows.
const EMPTY = 'grimoire_t_tenancy_empty';
const AT_0008 = 'grimoire_t_tenancy_0008';
const upTo0008 = path.join(repoRoot, 'test-results', 'tenancy-migrations-0008');
const uuid = (n: number): string => `a0000000-3c1d-4a53-9a62-${String(n).padStart(12, '0')}`;
const TABLES = ['users', 'groups', 'group_members', 'collections', 'collection_access', 'pages', 'revisions', 'attachments', 'audit_events', 'idempotency_keys', 'imports', 'import_items'] as const;

const migrate = (db: string, dir?: string) => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate', ...(dir ? ['--dir', dir] : [])], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(db) });
const run = (db: string) => (statement: string) => sqlAdmin(db, statement);
/** The error a statement raises (a constraint, by its code), or undefined when it ran. */
async function refused(db: string, statement: string): Promise<string | undefined> {
  try { await sqlAdmin(db, statement); return undefined; } catch (error) { return String((error as { code?: unknown }).code ?? error); }
}

beforeAll(async () => {
  requireBuild();
  mkdirSync(upTo0008, { recursive: true });
  for (const name of readdirSync(path.join(repoRoot, 'db/migrations')).filter((n) => /^000[1-8]_.*\.ts$/.test(n))) cpSync(path.join(repoRoot, 'db/migrations', name), path.join(upTo0008, name));
  for (const db of [EMPTY, AT_0008]) await createTestDatabase(db, false);
}, 60_000);
afterAll(async () => {
  rmSync(upTo0008, { recursive: true, force: true });
  for (const db of [EMPTY, AT_0008]) await dropTestDatabase(db);
});

describe('migration 0009 on an empty database', () => {
  it('makes the legacy tenant, gives every tenant table a not null tenant_id that defaults to it, and a second run applies nothing', async () => {
    const first = await migrate(EMPTY);
    expect(first.code, first.output).toBe(0);
    expect(await sqlAdmin(EMPTY, `select id, name, domain from tenants`)).toEqual([{ id: 'legacy', name: 'Legacy workspace', domain: null }]);
    const columns = await sqlAdmin<{ table_name: string; is_nullable: string; column_default: string | null }>(EMPTY, `select table_name, is_nullable, column_default from information_schema.columns where table_schema = 'public' and column_name = 'tenant_id' order by table_name`);
    // The tables of 0009 only: a later migration adds tenant tables of its own (0011's carry no default: the writer names the tenant).
    const own = columns.filter((c) => (TABLES as readonly string[]).includes(c.table_name));
    expect(own.map((c) => c.table_name).sort()).toEqual([...TABLES].sort());
    for (const c of own) expect([c.table_name, c.is_nullable, c.column_default]).toEqual([c.table_name, 'NO', "'legacy'::text"]);
    const second = await migrate(EMPTY);
    expect(second.output).toContain('migrate.nothing_pending');
  });

  it('keeps the code of today working: an insert that names no tenant lands in the legacy tenant', async () => {
    const id = await insertUser(run(EMPTY), { descope_user_id: 'plain', email: 'plain@example.test' });
    expect(await sqlAdmin(EMPTY, `select tenant_id from users where id = '${id}'`)).toEqual([{ tenant_id: 'legacy' }]);
  });

  it('lets the runtime role read and add tenants and nothing more', async () => {
    const privileges = await sqlAdmin<{ privilege_type: string }>(EMPTY, `select privilege_type from information_schema.role_table_grants where table_name = 'tenants' and grantee = 'grimoire_app' order by 1`);
    expect(privileges.map((p) => p.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });
});

describe('migration 0009 on a database at 0008 that holds rows', () => {
  const ids = { admin: uuid(1), group: uuid(2), collection: uuid(3), page: uuid(4), revision: uuid(5), attachment: uuid(6), imported: uuid(7) };

  it('puts every existing row in the legacy tenant and loses none', async () => {
    expect((await migrate(AT_0008, upTo0008)).code).toBe(0);
    const r = run(AT_0008);
    await insertUser(r, { id: ids.admin, descope_user_id: 'admin-1', email: 'admin@example.test', role: 'admin' });
    await r(`insert into groups (id, name) values ('${ids.group}', 'Writers')`);
    await r(`insert into group_members (group_id, user_id) values ('${ids.group}', '${ids.admin}')`);
    await insertCollection(r, { id: ids.collection, position: 'a5' });
    await r(`insert into collection_access (collection_id, user_id, permission) values ('${ids.collection}', '${ids.admin}', 'read')`);
    await insertPage(r, { id: ids.page, collection_id: ids.collection });
    await r(`insert into revisions (id, page_id, title, markdown, markdown_hash, reason, created_at) values ('${ids.revision}', '${ids.page}', 'T', 'M', decode(repeat('00', 32), 'hex'), 'manual', now())`);
    await r(`insert into attachments (id, page_id, file_name, content_type, size, s3_key, status) values ('${ids.attachment}', '${ids.page}', 'a.png', 'image/png', 3, 'attachments/${ids.attachment}', 'ready')`);
    await r(`insert into audit_events (actor_id, action) values ('${ids.admin}', 'test')`);
    await r(`insert into idempotency_keys (user_id, key, request_hash) values ('${ids.admin}', 'k', decode(repeat('00', 32), 'hex'))`);
    await r(`insert into imports (id, target_collection_id, source) values ('${ids.imported}', '${ids.collection}', 'markdown_zip')`);
    await r(`insert into import_items (import_id, path, kind) values ('${ids.imported}', 'a.md', 'page')`);
    const before = Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await sqlAdmin<{ n: number }>(AT_0008, `select count(*)::int as n from ${t}`))[0]?.n])));

    const migrated = await migrate(AT_0008);
    expect(migrated.code, migrated.output).toBe(0);
    for (const t of TABLES) {
      expect([t, await sqlAdmin(AT_0008, `select count(*)::int as n from ${t}`)]).toEqual([t, [{ n: before[t] }]]);
      expect([t, await sqlAdmin(AT_0008, `select count(*)::int as n from ${t} where tenant_id <> 'legacy'`)]).toEqual([t, [{ n: 0 }]]);
    }
    expect((await sqlAdmin<{ id: string }>(AT_0008, `select id from pages where id = '${ids.page}'`)).length).toBe(1);
    expect(await sqlAdmin(AT_0008, `select id from collections where id = '${UNFILED_COLLECTION_ID}'`)).toHaveLength(1);
    expect(await sqlAdmin(AT_0008, `select id from users where id = '${SYSTEM_USER_ID}'`)).toHaveLength(1);
  });
});

describe('what the keys of migration 0009 refuse (every statement runs in its own transaction, so a deferred key is checked at once)', () => {
  const db = AT_0008;
  const t = { collection: uuid(20), user: uuid(21), group: uuid(22), page: uuid(23), imported: uuid(24) };
  beforeAll(async () => {
    const r = run(db);
    await r(`insert into tenants (id, name) values ('acme', 'acme.test'), ('beta', 'beta.test'), ('gamma', 'gamma.test')`);
    await r(`insert into users (id, descope_user_id, email, name, tenant_id) values ('${t.user}', 'acme-user', 'user@acme.test', 'user', 'acme')`);
    await r(`insert into groups (id, name, tenant_id) values ('${t.group}', 'Writers', 'acme')`);
    await r(`insert into collections (id, name, position, created_by, tenant_id) values ('${t.collection}', 'Docs', 'a1', '${t.user}', 'acme')`);
    await r(`insert into pages (id, collection_id, created_by, tenant_id) values ('${t.page}', '${t.collection}', '${t.user}', 'acme')`);
    await r(`insert into imports (id, target_collection_id, source, tenant_id) values ('${t.imported}', '${t.collection}', 'markdown_zip', 'acme')`);
  });

  it.each([
    ['a page in a collection of another tenant', () => `insert into pages (collection_id, created_by, tenant_id) values ('${t.collection}', '${t.user}', 'beta')`],
    ['a group member from another tenant than the group', () => `insert into group_members (group_id, user_id, tenant_id) values ('${t.group}', '${t.user}', 'beta')`],
    ['an access entry for a collection of another tenant', () => `insert into collection_access (collection_id, user_id, permission, tenant_id) values ('${t.collection}', '${t.user}', 'read', 'beta')`],
    ['a revision of a page of another tenant', () => `insert into revisions (page_id, title, markdown, markdown_hash, reason, created_at, tenant_id) values ('${t.page}', 'T', 'M', decode(repeat('00', 32), 'hex'), 'manual', now(), 'beta')`],
    ['an attachment of a page of another tenant', () => `insert into attachments (page_id, file_name, content_type, size, s3_key, status, tenant_id) values ('${t.page}', 'a.png', 'image/png', 3, 'k', 'ready', 'beta')`],
    ['an import item of an import of another tenant', () => `insert into import_items (import_id, path, kind, tenant_id) values ('${t.imported}', 'x.md', 'page', 'beta')`],
    ['a row of a tenant that does not exist', () => `insert into groups (name, tenant_id) values ('Ghosts', 'nobody')`],
  ])('refuses %s', async (_name, statement) => {
    expect(await refused(db, statement())).toBe('23503');
  });

  it('accepts the same rows in the tenant of their parents', async () => {
    expect(await refused(db, `insert into pages (collection_id, created_by, tenant_id) values ('${t.collection}', '${t.user}', 'acme')`)).toBeUndefined();
    expect(await refused(db, `insert into group_members (group_id, user_id, tenant_id) values ('${t.group}', '${t.user}', 'acme')`)).toBeUndefined();
  });

  it('keeps group names and collection positions unique within a tenant and free across tenants, and the email unique across all', async () => {
    expect(await refused(db, `insert into groups (name, tenant_id) values ('Writers', 'beta')`)).toBeUndefined();
    expect(await refused(db, `insert into groups (name, tenant_id) values ('writers', 'acme')`)).toBe('23505'); // citext: the case does not matter
    expect(await refused(db, `insert into collections (name, position, created_by, tenant_id) values ('Other', 'a1', '${SYSTEM_USER_ID}', 'beta')`)).toBeUndefined();
    expect(await refused(db, `insert into collections (name, position, created_by, tenant_id) values ('Again', 'a1', '${SYSTEM_USER_ID}', 'acme')`)).toBe('23505');
    expect(await refused(db, `insert into users (descope_user_id, email, name, tenant_id) values ('beta-user', 'USER@acme.test', 'x', 'beta')`)).toBe('23505');
  });

  it('lets a row and its parents change tenant together in one transaction and refuses a change of the child alone (what tenant-adopt relies on)', async () => {
    const alone = await refused(db, `update pages set tenant_id = 'beta' where id = '${t.page}'`);
    expect(alone).toBe('23503');
    const together = await refused(db, `begin; update collections set tenant_id = 'gamma' where id = '${t.collection}'; update pages set tenant_id = 'gamma' where collection_id = '${t.collection}'; update imports set tenant_id = 'gamma' where target_collection_id = '${t.collection}'; update import_items set tenant_id = 'gamma' where import_id = '${t.imported}'; update revisions set tenant_id = 'gamma' where page_id in (select id from pages where collection_id = '${t.collection}'); update attachments set tenant_id = 'gamma' where page_id in (select id from pages where collection_id = '${t.collection}'); update collection_access set tenant_id = 'gamma' where collection_id = '${t.collection}'; commit`);
    expect(together).toBeUndefined();
  });
});
