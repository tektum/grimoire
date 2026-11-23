import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { insertCollection, insertPage, SYSTEM_USER_ID, UNFILED_COLLECTION_ID } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, migratorUrl, repoRoot, requireBuild, runToEnd, serverDir, sqlAdmin } from '../../server/support/harness.js';

// Migrations 0005 (tables) and 0006 (search columns, indexes, unique positions) on an empty database and on one at 0004 holding rows.
const EMPTY = 'grimoire_m4t01_mig_empty';
const AT_0004 = 'grimoire_m4t01_mig_0004';
const PROBE = 'grimoire_m4t01_mig_probe';
const upTo0004 = path.join(repoRoot, 'test-results', 'm4t01-migrations-0004');
const withProbe = path.join(repoRoot, 'test-results', 'm4t01-migrations-probe');
const PARENT = 'b0000000-3c1d-4a53-9a62-5d1c2a7e8f10';

const migrate = (db: string, dir?: string) => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate', ...(dir ? ['--dir', dir] : [])], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(db) });
const admin = (db: string) => (statement: string) => sqlAdmin(db, statement);
const asApp = async <T>(db: string, statement: string): Promise<T[]> => {
  const handle = createDatabase(appUrl(db), { maxConnections: 1 });
  try { return await handle.query<T>(statement); } finally { await handle.close(); }
};

beforeAll(async () => {
  requireBuild();
  mkdirSync(upTo0004, { recursive: true });
  for (const name of ['0001_pages.ts', '0002_page_markdown.ts', '0003_schema_version.ts', '0004_permissions.ts']) cpSync(path.join(repoRoot, 'db/migrations', name), path.join(upTo0004, name));
  mkdirSync(withProbe, { recursive: true });
  for (const name of readdirSync(path.join(repoRoot, 'db/migrations')).filter((n) => /^\d{4}_.*\.ts$/.test(n))) cpSync(path.join(repoRoot, 'db/migrations', name), path.join(withProbe, name));
  // A migration after 0006 in the same run: the parent foreign key of 0004 must be deferred again, so a child may be inserted before its parent.
  writeFileSync(path.join(withProbe, '9999_probe.ts'), `import { sql } from 'kysely';\nimport type { Kysely } from 'kysely';\nexport async function up(db: Kysely<unknown>): Promise<void> {\n  await sql\`insert into pages (id, parent_id) values ('d1000000-3c1d-4a53-9a62-5d1c2a7e8f10', 'd2000000-3c1d-4a53-9a62-5d1c2a7e8f10')\`.execute(db);\n  await sql\`insert into pages (id) values ('d2000000-3c1d-4a53-9a62-5d1c2a7e8f10')\`.execute(db);\n}\n`);
  for (const db of [EMPTY, AT_0004, PROBE]) await createTestDatabase(db, false);
}, 60_000);
afterAll(async () => {
  rmSync(upTo0004, { recursive: true, force: true });
  rmSync(withProbe, { recursive: true, force: true });
  for (const db of [EMPTY, AT_0004, PROBE]) await dropTestDatabase(db);
});

describe('migrations 0005 and 0006', () => {
  it('apply on an empty database, and a second run applies nothing', async () => {
    const first = await migrate(EMPTY);
    expect(first.code, first.output).toBe(0);
    expect(await sqlAdmin(EMPTY, 'select count(*)::int as n from kysely_migration')).toEqual([{ n: 7 }]);
    const second = await migrate(EMPTY);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain('migrate.nothing_pending');
  });

  it('renumber the sibling positions of a database at 0004 that holds rows', async () => {
    expect((await migrate(AT_0004, upTo0004)).code).toBe(0);
    const run = admin(AT_0004);
    await insertPage(run, { id: PARENT });
    for (let i = 0; i < 3; i += 1) await insertPage(run, { parent_id: PARENT }); // three siblings with the default position a0
    const OTHER = 'b1000000-3c1d-4a53-9a62-5d1c2a7e8f10';
    await insertPage(run, { id: OTHER });
    const createdFirst = await insertPage(run, { parent_id: OTHER, position: 'a1' });
    const createdSecond = await insertPage(run, { parent_id: OTHER, position: 'a0' }); // created after the other, but ordered before it
    await insertCollection(run, { position: 'a0' }); // and two collections with the same position as "Unfiled"
    await insertCollection(run, { position: 'a0' });
    expect(await sqlAdmin(AT_0004, `select count(distinct position)::int as n from pages where parent_id = '${PARENT}'`)).toEqual([{ n: 1 }]);

    const migrated = await migrate(AT_0004);
    expect(migrated.code, migrated.output).toBe(0);
    const siblings = await sqlAdmin<{ position: string }>(AT_0004, `select position from pages where parent_id = '${PARENT}' order by position`);
    expect(siblings.map((r) => r.position)).toEqual(['a00000011', 'a00000021', 'a00000031']);
    const ordered = await sqlAdmin<{ id: string }>(AT_0004, `select id from pages where parent_id = '${OTHER}' order by position`);
    expect(ordered.map((r) => r.id)).toEqual([createdSecond, createdFirst]); // distinct positions keep their order
    const collections = await sqlAdmin<{ id: string; position: string }>(AT_0004, 'select id, position from collections order by position');
    expect(new Set(collections.map((r) => r.position)).size).toBe(3);
    expect(collections.find((r) => r.id === UNFILED_COLLECTION_ID)).toBeDefined();
    const again = await migrate(AT_0004);
    expect(again.output).toContain('migrate.nothing_pending');
  });

  it('leave the parent foreign key deferred for a migration that runs after 0006 in the same run', async () => {
    const result = await migrate(PROBE, withProbe);
    expect(result.code, result.output).toBe(0);
    expect(await sqlAdmin(PROBE, `select count(*)::int as n from pages where id in ('d1000000-3c1d-4a53-9a62-5d1c2a7e8f10', 'd2000000-3c1d-4a53-9a62-5d1c2a7e8f10')`)).toEqual([{ n: 2 }]);
  });

  it('keep two siblings from sharing a position, top-level pages included, but allow it once a page is deleted', async () => {
    const run = admin(EMPTY);
    const collection = await insertCollection(run, { position: 'b0' });
    await insertPage(run, { collection_id: collection, position: 'a1' });
    await expect(insertPage(run, { collection_id: collection, position: 'a1' })).rejects.toMatchObject({ code: '23505' });
    await insertPage(run, { collection_id: collection, position: 'a1', deleted_at: new Date() });
    await expect(insertCollection(run, { position: 'b0' })).rejects.toMatchObject({ code: '23505' });
  });

  it('give each bare page insert its own default position', async () => {
    const run = admin(EMPTY);
    await insertPage(run);
    await insertPage(run);
    const rows = await sqlAdmin<{ position: string }>(EMPTY, `select position from pages where collection_id = '${UNFILED_COLLECTION_ID}' and created_by = '${SYSTEM_USER_ID}'`);
    expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
    for (const row of rows) expect(row.position).toMatch(/^a0\d{6,7}1$/);
  });

  it('maintain tsv from the title (weight A) and the text (weight B) on insert and on update', async () => {
    const run = admin(EMPTY);
    const id = await insertPage(run, { title: 'Quarterly plan', text_content: 'budget and hiring' });
    const query = (term: string) => sqlAdmin<{ id: string }>(EMPTY, `select id from pages where tsv @@ to_tsquery('simple', '${term}') and id = '${id}'`);
    expect(await query('quarterly')).toHaveLength(1);
    expect(await query('hiring')).toHaveLength(1);
    expect(await query('quarterly:A')).toHaveLength(1); // the title weighs A
    expect(await query('hiring:B')).toHaveLength(1); // the text weighs B
    expect(await query('hiring:A')).toHaveLength(0);
    expect(await sqlAdmin(EMPTY, `select search_partial from pages where id = '${id}'`)).toEqual([{ search_partial: false }]);
    await sqlAdmin(EMPTY, `update pages set text_content = 'roadmap' where id = '${id}'`);
    expect(await query('hiring')).toHaveLength(0);
    expect(await query('roadmap')).toHaveLength(1);
  });

  it('index a page whose body overflows the tsvector limit by a prefix, and say so with search_partial', async () => {
    const run = admin(EMPTY);
    // Distinct words saturate the 1,048,575-byte limit well before 1.5 MB of text.
    const id = await insertPage(run, { title: 'Large page', text_content: raw_words(150_000) });
    const [row] = await sqlAdmin<{ partial: boolean; indexed: boolean }>(EMPTY, `select search_partial as partial, tsv @@ to_tsquery('simple', 'large') as indexed from pages where id = '${id}'`);
    expect(row).toEqual({ partial: true, indexed: true });
  }, 60_000);

  it('give the runtime role what it needs and nothing more', async () => {
    const privileges = await sqlAdmin<{ t: string; truncate: boolean }>(EMPTY, `
      select t, has_table_privilege('grimoire_app', t, 'TRUNCATE') as truncate
        from unnest(array['revisions','attachments','imports','import_items','audit_events','idempotency_keys']) as t`);
    expect(privileges.every((r) => !r.truncate)).toBe(true);
    await asApp(EMPTY, `insert into audit_events (action) values ('test')`);
    await asApp(EMPTY, `insert into import_items (import_id, path, kind) select id, 'a.md', 'page' from imports limit 0`);
    await expect(asApp(EMPTY, 'create table x()')).rejects.toMatchObject({ code: '42501' });
    await insertPage(admin(EMPTY), { id: 'c0000000-3c1d-4a53-9a62-5d1c2a7e8f10' });
    await asApp(EMPTY, `insert into revisions (page_id, title, markdown, markdown_hash, reason, created_at) values ('c0000000-3c1d-4a53-9a62-5d1c2a7e8f10', 't', 'm', decode(repeat('ab', 32), 'hex'), 'manual', now())`);
    await expect(asApp(EMPTY, `update revisions set title = 'x'`)).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(EMPTY, `update audit_events set action = 'x'`)).rejects.toMatchObject({ code: '42501' });
  });
});

/** Distinct words: five letters from a counter, so every one is a new lexeme. */
function raw_words(count: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let n = i;
    let word = 'w';
    for (let k = 0; k < 5; k += 1) { word += letters[n % 26]; n = Math.floor(n / 26); }
    words.push(word);
  }
  return words.join(' ');
}
