import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachmentRepoConformance } from '@tektum/grimoire-core/testing/attachment-repo-conformance';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createAttachments } from '../../src/attachments.js';
import { scoped } from '../../src/index.js';
import { createCollections } from '../../src/collections.js';
import { createPages } from '../../src/pages.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';
import type { AttachmentRepo } from '@tektum/grimoire-core/ports/attachment-repo';

let t: TestDatabase;
let pageId: string;
let userId: string;
let otherUserId: string;
let parallelUserId: string;
const ordering = new FakeOrdering();
const NOW = 1_700_000_000_000;

/** `insertReady` runs on the caller's transaction (the importer's, scoped already): a call with none gets one scoped to the tenant of these tests' rows, which row-level security needs. */
const asLegacy = (repo: AttachmentRepo): AttachmentRepo => ({
  ...repo,
  insertReady: (row, tx) => (tx === undefined ? scoped(t.app, 'legacy').transaction((q) => repo.insertReady(row, q)) : repo.insertReady(row, tx)),
});

const newPage = async (): Promise<string> => {
  const collection = await createCollections(t.app).append('legacy', { name: `c${randomUUID().slice(0, 8)}`, createdBy: userId }, (last) => ordering.between(last, null));
  const made = await createPages(t.app).create('legacy', { collectionId: collection.id, parentId: null, afterId: null, title: 'T', createdBy: userId }, { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 }, (a, b) => ordering.between(a, b));
  if (made.kind !== 'created') throw new Error(made.kind);
  return made.page.id;
};

beforeAll(async () => {
  t = await createTestDatabase('attachments');
  userId = await addUser(t.app, 'ada', 'admin');
  otherUserId = await addUser(t.app, 'bo', 'member');
  parallelUserId = await addUser(t.app, 'cy', 'member');
  pageId = await newPage();
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL AttachmentRepo meets the conformance cases', () => {
  for (const c of attachmentRepoConformance) {
    it(c.name, async () => {
      await c.run({ repo: asLegacy(createAttachments(t.app)), pageId, userId, otherUserId, parallelUserId, missingPageId: randomUUID(), missingUserId: randomUUID(), now: NOW });
    }, 30_000);
  }
});

describe('what only the database does', () => {
  const pending = (id: string, tenantId = 'legacy') => ({ id, pageId, uploaderId: userId, fileName: 'x.txt', contentType: 'text/plain', size: 5, key: `attachments/${id}`, expiresAt: NOW + 3_600_000, tenantId });

  it('stores a pending row in the tenant it is given (tenants, docs/tenancy.md 3.5), and another tenant does not see it', async () => {
    const repo = asLegacy(createAttachments(t.app));
    const made = await repo.createPending(pending(randomUUID()), 100, NOW);
    if (made.kind !== 'created') throw new Error(made.kind);
    expect(made.row.tenantId).toBe('legacy');
    expect(await repo.get('other', made.row.id)).toBeUndefined();
    expect(await repo.getMany('other', [made.row.id])).toEqual([]);
    expect(await repo.markReady('other', made.row.id, NOW)).toBeUndefined();
    expect(await repo.removeIfPending('other', made.row.id)).toBe(false);
    await repo.remove('other', made.row.id);
    expect(await repo.get('legacy', made.row.id)).toMatchObject({ status: 'pending' });
  });

  it('refuses a pending row whose tenant is not its page\'s (the keys between tenants would not hold): it is not created', async () => {
    const repo = asLegacy(createAttachments(t.app));
    await t.admin.query(`insert into tenants (id, name) values ('other', 'Other') on conflict do nothing`, []);
    const r = await repo.createPending(pending(randomUUID(), 'other'), 100, NOW);
    expect(r.kind).not.toBe('created');
  });

  it('lets an error that is not a missing page through, and stores nothing', async () => {
    const repo = asLegacy(createAttachments(t.app));
    const id = randomUUID();
    await expect(repo.createPending({ ...pending(id), uploaderId: 'not-a-uuid' }, 100, NOW)).rejects.toMatchObject({ code: '22P02' });
    expect(await repo.get('legacy', id)).toBeUndefined();
  });

  const ready = (id: string, page: string) => ({ id, pageId: page, uploaderId: userId, fileName: 'x.txt', contentType: 'text/plain', size: 5, key: `attachments/${id}`, readyAt: NOW });

  it('stores a ready row inside the caller\'s transaction: it commits with it and a rollback leaves no row', async () => {
    const repo = asLegacy(createAttachments(t.app));
    const kept = randomUUID();
    const gone = randomUUID();
    await scoped(t.app, 'legacy').transaction(async (tx) => { await repo.insertReady(ready(kept, pageId), tx); });
    await expect(scoped(t.app, 'legacy').transaction(async (tx) => {
      await repo.insertReady(ready(gone, pageId), tx);
      throw new Error('the page failed to save');
    })).rejects.toThrow('the page failed to save');
    expect(await repo.get('legacy', kept)).toMatchObject({ status: 'ready', size: 5 });
    expect(await repo.get('legacy', gone)).toBeUndefined();
  });

  it('removes the rows of a page with the page, and leaves the rows of another page', async () => {
    const repo = asLegacy(createAttachments(t.app));
    const doomed = await newPage();
    const other = await newPage();
    const a = randomUUID();
    const b = randomUUID();
    await repo.insertReady(ready(a, doomed));
    await repo.insertReady(ready(b, other));
    await t.admin.query(`delete from pages where id = $1`, [doomed]);
    expect(await repo.get('legacy', a)).toBeUndefined();
    expect(await repo.get('legacy', b)).toBeDefined();
  });

  it('keeps the row of an uploader whose account is gone, with no uploader', async () => {
    const repo = asLegacy(createAttachments(t.app));
    const leaver = await addUser(t.app, `leaver${randomUUID().slice(0, 4)}`, 'member');
    const id = randomUUID();
    await repo.insertReady({ ...ready(id, pageId), uploaderId: leaver });
    await t.admin.query(`delete from users where id = $1`, [leaver]);
    expect(await repo.get('legacy', id)).toMatchObject({ uploaderId: null, status: 'ready' });
  });

  it('refuses a size that no number holds exactly, and hides a row the trash purge marked deleted', async () => {
    const repo = asLegacy(createAttachments(t.app));
    const huge = randomUUID();
    await t.admin.query(
      `insert into attachments (id, page_id, uploader_id, file_name, content_type, size, s3_key, status, ready_at) values ($1, $2, $3, 'h.bin', 'application/zip', 9007199254740993, $4, 'ready', now())`,
      [huge, pageId, userId, `attachments/${huge}`],
    );
    await expect(repo.get('legacy', huge)).rejects.toThrow('safe integer');
    const marked = randomUUID();
    await repo.insertReady(ready(marked, pageId));
    await t.admin.query(`update attachments set deleted_at = now() where id = $1`, [marked]);
    expect(await repo.get('legacy', marked)).toBeUndefined();
    expect(await repo.getMany('legacy', [marked])).toEqual([]);
  });

  it('does not complete or count a pending upload the trash purge marked deleted, and still lists it for clean-up', async () => {
    const repo = asLegacy(createAttachments(t.app));
    const owner = await addUser(t.app, 'purge-pending', 'member');
    const now = Date.now();
    const id = randomUUID();
    const made = await repo.createPending({ id, pageId, uploaderId: owner, fileName: 'p.png', contentType: 'image/png', size: 5, key: `attachments/${id}`, expiresAt: now + 3_600_000, tenantId: 'legacy' }, 1, now);
    expect(made.kind).toBe('created');
    await t.admin.query(`update attachments set deleted_at = now() where id = $1`, [id]);
    expect(await repo.markReady('legacy', id, now)).toBeUndefined();
    const next = randomUUID();
    const again = await repo.createPending({ id: next, pageId, uploaderId: owner, fileName: 'q.png', contentType: 'image/png', size: 5, key: `attachments/${next}`, expiresAt: now + 3_600_000, tenantId: 'legacy' }, 1, now);
    expect(again.kind).toBe('created'); // the marked row does not use up the cap of one
    expect((await repo.expiredPending('legacy', now + 4_000_000, 1000)).map((r) => r.id)).toContain(id);
  });
});
