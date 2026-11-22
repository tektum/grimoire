import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, runToEnd, serverDir, sqlAdmin } from '../server/support/harness.js';

const DB = 'grimoire_m3t03_seed';
const seed = (env: Record<string, string>) => runToEnd([path.join(serverDir, 'dist/cli.js'), 'seed'], { GRIMOIRE_DATABASE_URL: appUrl(DB), ...env });
const LOCAL = { GRIMOIRE_LOCAL: '1' };
const count = async (table: string) => Number((await sqlAdmin<{ n: string }>(DB, `select count(*) as n from ${table}`))[0]?.n);
// The migration's own system user and "Unfiled" collection are not seed rows.
const SYSTEM = '00000000-0000-4000-8000-000000000001';

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterAll(async () => { await dropTestDatabase(DB); });

describe('grimoire seed', () => {
  it('with GRIMOIRE_LOCAL=0 (and a project id, so the settings load) it exits 2, names GRIMOIRE_LOCAL and inserts nothing', async () => {
    const r = await seed({ GRIMOIRE_LOCAL: '0', GRIMOIRE_DESCOPE_PROJECT_ID: 'Ptest', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test' });
    expect(r.code).toBe(2);
    expect(r.output).toContain('GRIMOIRE_LOCAL');
    expect(await count('users')).toBe(1);
    expect(await count('collections')).toBe(1);
    expect(await count('pages')).toBe(0);
  });

  it('with GRIMOIRE_LOCAL=1, run twice, leaves exactly alice, bob, carol, "Dev", "Private" and two pages', async () => {
    expect((await seed(LOCAL)).code).toBe(0);
    expect((await seed(LOCAL)).code).toBe(0);
    expect(await sqlAdmin(DB, `select id, descope_user_id, role from users where id <> '${SYSTEM}' order by descope_user_id`)).toEqual([
      { id: '00000000-0000-4000-8000-0000000000a1', descope_user_id: 'alice', role: 'admin' },
      { id: '00000000-0000-4000-8000-0000000000b1', descope_user_id: 'bob', role: 'member' },
      { id: '00000000-0000-4000-8000-0000000000c1', descope_user_id: 'carol', role: 'viewer' },
    ]);
    expect(await sqlAdmin(DB, "select id, name, default_permission from collections where name <> 'Unfiled' order by name")).toEqual([
      { id: '00000000-0000-4000-8000-0000000000d1', name: 'Dev', default_permission: 'read_write' },
      { id: '00000000-0000-4000-8000-0000000000d2', name: 'Private', default_permission: null },
    ]);
    expect(await sqlAdmin(DB, "select user_id, group_id, permission from collection_access where collection_id = '00000000-0000-4000-8000-0000000000d2'")).toEqual([
      { user_id: '00000000-0000-4000-8000-0000000000b1', group_id: null, permission: 'read_write' },
    ]);
    const pages = await sqlAdmin<{ title: string; collection_id: string; parent_id: string | null; ydoc: Buffer | null; markdown: string | null }>(DB, 'select title, collection_id, parent_id, ydoc, markdown from pages order by title');
    expect(pages).toHaveLength(2);
    const [nested, welcome] = pages;
    expect(welcome).toMatchObject({ title: 'Welcome', collection_id: '00000000-0000-4000-8000-0000000000d1', parent_id: null, ydoc: null });
    expect(nested).toMatchObject({ title: 'Nested', collection_id: '00000000-0000-4000-8000-0000000000d1', ydoc: null });
    expect(nested?.parent_id).not.toBeNull();
    for (const p of pages) expect((p.markdown ?? '').length).toBeGreaterThan(0);
    expect(await count('users')).toBe(4);
    expect(await count('collections')).toBe(3);
    expect(await count('collection_access')).toBe(1);
  });

  it('with GRIMOIRE_LOCAL=0 and no project id the settings are invalid: exit 2, GRIMOIRE_LOCAL named', async () => {
    const before = await count('pages');
    const r = await seed({ GRIMOIRE_LOCAL: '0' });
    expect(r.code).toBe(2);
    expect(r.output).toContain('GRIMOIRE_LOCAL');
    expect(await count('pages')).toBe(before);
  });

  it('exits 2 without a database URL', async () => {
    const r = await runToEnd([path.join(serverDir, 'dist/cli.js'), 'seed'], { GRIMOIRE_LOCAL: '1' });
    expect(r.code).toBe(2);
    expect(r.output).toContain('GRIMOIRE_DATABASE_URL');
  });
});

describe('grimoire seed after a local sign-in', () => {
  const SIGNED_IN_DB = `grimoire_m3t03_seed_signin_${String(process.pid)}`;
  it('a developer who signed in as alice before seeding still gets the seed, built on the row the sign-in made', async () => {
    await createTestDatabase(SIGNED_IN_DB, true);
    try {
      const signedIn = '11111111-2222-4333-8444-555555555555';
      await sqlAdmin(SIGNED_IN_DB, `insert into users (id, descope_user_id, email, name, role) values ('${signedIn}', 'alice', 'alice@dev.invalid', 'alice', 'admin')`);
      const r = await runToEnd([path.join(serverDir, 'dist/cli.js'), 'seed'], { GRIMOIRE_DATABASE_URL: appUrl(SIGNED_IN_DB), ...LOCAL });
      expect(r.code).toBe(0);
      const users = await sqlAdmin<{ descope_user_id: string }>(SIGNED_IN_DB, `select descope_user_id from users where id <> '${SYSTEM}' order by descope_user_id`);
      expect(users.map((u) => u.descope_user_id)).toEqual(['alice', 'bob', 'carol']);
      const made = await sqlAdmin<{ n: string }>(SIGNED_IN_DB, `select count(*) as n from collections where created_by = '${signedIn}'`);
      expect(Number(made[0]?.n)).toBeGreaterThan(0); // the seeded collections belong to the existing alice, not to a second one
      const pages = await sqlAdmin<{ n: string }>(SIGNED_IN_DB, 'select count(*) as n from pages');
      expect(Number(pages[0]?.n)).toBe(2);
    } finally { await dropTestDatabase(SIGNED_IN_DB); }
  }, 60_000);
});
