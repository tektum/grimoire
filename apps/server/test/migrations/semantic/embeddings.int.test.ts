import { randomUUID } from 'node:crypto';
import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { insertCollection, insertPage, insertSql, insertUser, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from '../../server/support/harness.js';

// M7-T11 (contracts section 15.3, decision 11): the two embedding tables, in a migrated database. pgvector reaches the database the way it does on a managed service: the
// administrator makes it available before `grimoire migrate` (the init step locally, `grimoire db-setup` on RDS), because the migration role cannot create it.
const DB = 'grimoire_m7t11_embeddings';
const run = (text: string): Promise<unknown> => sqlAdmin(DB, text);
const hash = (byte = '00') => raw(`decode(repeat('${byte}', 32), 'hex')`);
const vector = (n: number): string => `[${Array.from({ length: n }, (_, i) => String((i % 5) + 1)).join(',')}]`;

let app: ReturnType<typeof createDatabase>;
let tenant: string;
let page: string;

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  app = createDatabase(appUrl(DB), { maxConnections: 2 });
  await run(`insert into tenants (id, name) values ('T-embed', 'Embed'), ('T-other', 'Other')`);
  tenant = 'T-embed';
  const user = await insertUser(run, { tenant_id: tenant });
  const collection = await insertCollection(run, { created_by: user, tenant_id: tenant });
  page = await insertPage(run, { collection_id: collection, created_by: user, tenant_id: tenant });
}, 120_000);
afterAll(async () => { await app?.close(); await dropTestDatabase(DB); });

const chunk = (over: Record<string, string | number | ReturnType<typeof raw>> = {}) => insertSql('page_chunks', {
  page_id: page, tenant_id: tenant, chunk_index: 0, model: 'test-model@00000000', content_hash: hash(), char_start: 0, char_end: 10, token_count: 3, embedding: vector(4), ...over,
});
const state = (over: Record<string, string | number | ReturnType<typeof raw>> = {}) => insertSql('page_embedding_state', { page_id: page, tenant_id: tenant, markdown_hash: hash(), model: 'test-model@00000000', status: 'ready', ...over });
const rejected = (text: string): Promise<unknown> => run(text).then(() => 'accepted', (e: { code?: string }) => e.code);

describe('the embedding tables', () => {
  it('hold chunks of any dimension in one column, and a state row for each page', async () => {
    await run(chunk({ chunk_index: 0, embedding: vector(768) }));
    await run(chunk({ chunk_index: 1, embedding: vector(384) }));
    await run(state());
    const rows = await sqlAdmin<{ chunk_index: number; dims: number }>(DB, `select chunk_index, vector_dims(embedding) as dims from page_chunks where page_id = '${page}' order by chunk_index`);
    expect(rows).toEqual([{ chunk_index: 0, dims: 768 }, { chunk_index: 1, dims: 384 }]);
    expect(await sqlAdmin(DB, `select chunk_count, attempts, error from page_embedding_state where page_id = '${page}'`)).toEqual([{ chunk_count: 0, attempts: 0, error: null }]);
  });

  it('refuse a hash that is not 32 bytes, a status that is not ready or failed, and a second row for the same chunk or page', async () => {
    expect(await rejected(chunk({ chunk_index: 2, content_hash: raw(`decode(repeat('00', 31), 'hex')`) }))).toBe('23514');
    expect(await rejected(insertSql('page_embedding_state', { page_id: page, tenant_id: tenant, markdown_hash: raw(`decode(repeat('00', 31), 'hex')`), model: 'm', status: 'ready' }))).toBe('23514');
    expect(await rejected(chunk({ chunk_index: 0 }))).toBe('23505');
    expect(await rejected(state())).toBe('23505');
    await run(`delete from page_embedding_state where page_id = '${page}'`);
    expect(await rejected(state({ status: 'queued' }))).toBe('23514');
    for (const status of ['ready', 'failed']) {
      await run(`delete from page_embedding_state where page_id = '${page}'`);
      expect(await rejected(state({ status }))).toBe('accepted');
    }
  });

  it('keep a row in the tenant of its page: another tenant is refused at the commit by the composite key', async () => {
    expect(await rejected(chunk({ chunk_index: 5, tenant_id: 'T-other' }))).toBe('23503');
    await run(`delete from page_embedding_state where page_id = '${page}'`);
    expect(await rejected(state({ tenant_id: 'T-other' }))).toBe('23503');
    expect(await rejected(chunk({ chunk_index: 6, tenant_id: 'no-such-tenant' }))).toBe('23503');
  });

  it('have no default tenant: a writer that forgets it is refused', async () => {
    expect(await rejected(insertSql('page_chunks', { page_id: page, chunk_index: 7, model: 'm', content_hash: hash(), char_start: 0, char_end: 1, token_count: 1, embedding: vector(2) }))).toBe('23502');
  });

  it('go with the page: purging a page removes its chunks and its state', async () => {
    const user = (await sqlAdmin<{ id: string }>(DB, `select id from users where tenant_id = '${tenant}' limit 1`))[0]?.id as string;
    const collection = (await sqlAdmin<{ id: string }>(DB, `select id from collections where tenant_id = '${tenant}' limit 1`))[0]?.id as string;
    const doomed = await insertPage(run, { collection_id: collection, created_by: user, tenant_id: tenant, id: randomUUID() });
    await run(insertSql('page_chunks', { page_id: doomed, tenant_id: tenant, chunk_index: 0, model: 'm', content_hash: hash(), char_start: 0, char_end: 1, token_count: 1, embedding: vector(3) }));
    await run(insertSql('page_embedding_state', { page_id: doomed, tenant_id: tenant, markdown_hash: hash(), model: 'm', status: 'ready' }));
    await run(`delete from pages where id = '${doomed}'`);
    expect(await sqlAdmin(DB, `select (select count(*)::int from page_chunks where page_id = '${doomed}') as chunks, (select count(*)::int from page_embedding_state where page_id = '${doomed}') as states`)).toEqual([{ chunks: 0, states: 0 }]);
  });
});

describe('the runtime role on the embedding tables', () => {
  it('may select, insert, update and delete', async () => {
    const id = (await sqlAdmin<{ id: string }>(DB, `select id from pages where tenant_id = '${tenant}' limit 1`))[0]?.id as string;
    await app.query(`insert into page_chunks (page_id, tenant_id, chunk_index, model, content_hash, char_start, char_end, token_count, embedding) values ($1, $2, 40, 'm', decode(repeat('00', 32), 'hex'), 0, 1, 1, $3::vector)`, [id, tenant, vector(5)]);
    await app.query(`update page_chunks set token_count = 2 where page_id = $1 and chunk_index = 40`, [id]);
    expect(await app.query(`select token_count from page_chunks where page_id = $1 and chunk_index = 40`, [id])).toEqual([{ token_count: 2 }]);
    await app.query(`delete from page_chunks where page_id = $1 and chunk_index = 40`, [id]);
    await app.query(`insert into page_embedding_state (page_id, tenant_id, markdown_hash, model, status) values ($1, $2, decode(repeat('01', 32), 'hex'), 'm', 'ready')`, [id, tenant]);
    await app.query(`update page_embedding_state set status = 'failed', attempts = 1 where page_id = $1`, [id]);
    expect(await app.query(`select status, attempts from page_embedding_state where page_id = $1`, [id])).toEqual([{ status: 'failed', attempts: 1 }]);
    await app.query(`insert into page_embedding_state (page_id, tenant_id, markdown_hash, model, status) values ($1, $2, decode(repeat('02', 32), 'hex'), 'm', 'ready') on conflict (page_id) do update set status = 'ready', attempts = 0`, [id, tenant]); // the upsert the jobs will use
    expect(await app.query(`select status, attempts from page_embedding_state where page_id = $1`, [id])).toEqual([{ status: 'ready', attempts: 0 }]);
    await app.query(`delete from page_embedding_state where page_id = $1`, [id]);
  });

  it('may not truncate either table, or create a table: those are refused with 42501', async () => {
    for (const statement of ['truncate page_chunks', 'truncate page_embedding_state', 'create table x()']) {
      await expect(app.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('holds exactly select, insert, update and delete on both tables, and no references or trigger', async () => {
    const grants = await sqlAdmin<{ table_name: string; privilege_type: string }>(DB,
      `select table_name, privilege_type from information_schema.role_table_grants where grantee = 'grimoire_app' and table_name in ('page_chunks', 'page_embedding_state') order by 1, 2`);
    expect(grants.map((g) => `${g.table_name} ${g.privilege_type}`)).toEqual([
      'page_chunks DELETE', 'page_chunks INSERT', 'page_chunks SELECT', 'page_chunks UPDATE',
      'page_embedding_state DELETE', 'page_embedding_state INSERT', 'page_embedding_state SELECT', 'page_embedding_state UPDATE',
    ]);
  });
});
