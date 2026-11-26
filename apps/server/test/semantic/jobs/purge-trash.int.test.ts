import { randomUUID } from 'node:crypto';
import { createEmbeddingStore, createPages, createTenants, createTrash } from '@tektum/grimoire-adapter-db-kysely';
import { insertPage, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPurge } from '../../../src/jobs/purge.js';
import { jobsDatabase, seedTenant } from '../../jobs/support.js';

// M7-T13: the chunks and the state of a page are its own rows, so the trash keeps them and the purge takes them with the page (the foreign keys), with the real adapters and the real purge job.
const DB = 'grimoire_m7t13_purge_trash';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

const rowsOf = async (pageId: string): Promise<{ chunks: number; states: number }> => {
  const [row] = (await db.sql(`select (select count(*)::int from page_chunks where page_id = '${pageId}') as chunks, (select count(*)::int from page_embedding_state where page_id = '${pageId}') as states`)) as { chunks: number; states: number }[];
  return { chunks: row?.chunks ?? -1, states: row?.states ?? -1 };
};

describe('the trash and the purge, for an embedded page', () => {
  it('trashing a page deletes none of its chunks or its state; the purge of its batch removes the rows of both tables with the page, and a page that is not in the trash keeps its own', async () => {
    const tenant = await seedTenant(db.sql, 'T-purge-trash');
    const store = createEmbeddingStore(db.app, db.ops);
    const hash = new Uint8Array(32).fill(0x0c);
    const embeddedPage = async (): Promise<string> => {
      const id = randomUUID();
      await insertPage(db.sql, {
        id, collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: 'T', text_content: 'alpha beta gamma',
        markdown_hash: raw(`decode(repeat('0c', 32), 'hex')`), last_edited_at: raw(`now() - interval '5 minutes'`),
      });
      await store.replacePage(tenant.tenantId, id, hash, 'purge-model-v1', [{ chunkIndex: 0, contentHash: new Uint8Array(32).fill(1), charStart: 0, charEnd: 5, tokenCount: 3, embedding: new Float32Array(8).fill(0.1) }]);
      return id;
    };
    const trashed = await embeddedPage();
    const live = await embeddedPage();
    expect(await rowsOf(trashed)).toEqual({ chunks: 1, states: 1 });

    expect(await createPages(db.app).softDelete(tenant.tenantId, trashed, tenant.userId, tenant.collectionId)).toEqual({ kind: 'deleted', pages: 1 });
    expect(await rowsOf(trashed)).toEqual({ chunks: 1, states: 1 }); // in the trash: nothing is deleted
    expect(await store.counts('purge-model-v1')).toMatchObject({ pagesReady: 1 }); // a page in the trash is not a page of the search

    const deps = { tenants: createTenants(db.ops), trash: createTrash(db.app), deleteFiles: () => Promise.resolve(), now: () => Date.now() + 31 * 86_400_000 };
    expect(await runPurge(deps, new AbortController().signal)).toMatchObject({ pages: 1 });
    expect(await rowsOf(trashed)).toEqual({ chunks: 0, states: 0 });
    expect(await rowsOf(live)).toEqual({ chunks: 1, states: 1 });
  }, 60_000);
});
