import { createRevisions } from '@tektum/grimoire-adapter-db-kysely';
import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import { insertPage, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRevisionCatchUp } from '../../src/jobs/revision-catchup.js';
import { jobsDatabase, seedTenant } from './support.js';

let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase('grimoire_m7t02_catchup'); }, 120_000);
afterAll(async () => { await db?.drop(); });

/** The stored hash of a page is the rule's hash of its title and Markdown (what the page store writes): the job and the first-open path both compare against it. */
const hashOf = (title: string, markdown: string) => raw(`decode('${Buffer.from(markdownHash(title, markdown)).toString('hex')}', 'hex')`);

const revisions = async (page: string): Promise<{ reason: string }[]> => (await db.sql(`select reason from revisions where page_id = '${page}'`)) as { reason: string }[];

describe('the revision catch-up job on a real database', () => {
  it('gives a page saved six minutes ago one idle revision, leaves one saved four minutes ago, and a second run changes nothing', async () => {
    const tenant = await seedTenant(db.sql, 'T-catchup');
    const saved = (minutes: number) => insertPage(db.sql, {
      collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: 'T', markdown: 'M',
      markdown_hash: hashOf('T', 'M'), last_edited_at: raw(`now() - interval '${String(minutes)} minutes'`), last_edited_by: tenant.userId,
    });
    const [old, recent] = [await saved(6), await saved(4)];
    const deps = { revisions: createRevisions(db.app, db.ops), now: () => Date.now() };
    expect(await runRevisionCatchUp(deps, new AbortController().signal)).toBe(1);
    expect(await revisions(old)).toEqual([{ reason: 'idle' }]);
    expect(await revisions(recent)).toEqual([]);
    expect(await runRevisionCatchUp(deps, new AbortController().signal)).toBe(0);
    expect(await revisions(old)).toHaveLength(1);
  }, 60_000);

  it('yields one revision when the job and a first-open query run on the same page at once', async () => {
    const tenant = await seedTenant(db.sql, 'T-catchup-race');
    const page = await insertPage(db.sql, {
      collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: 'T', markdown: 'M',
      markdown_hash: hashOf('T', 'M'), last_edited_at: raw(`now() - interval '6 minutes'`), last_edited_by: tenant.userId,
    });
    const revisionRepo = createRevisions(db.app, db.ops);
    await Promise.all([
      runRevisionCatchUp({ revisions: revisionRepo, now: () => Date.now() }, new AbortController().signal),
      revisionRepo.createFromPage({ tenantId: tenant.tenantId, pageId: page, reason: 'idle', authorIds: [tenant.userId], lastAuthorId: tenant.userId, at: Date.now() - 6 * 60_000 }),
    ]);
    expect(await revisions(page)).toHaveLength(1);
  }, 60_000);
});
