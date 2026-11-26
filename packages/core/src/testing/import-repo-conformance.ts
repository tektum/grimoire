import assert from 'node:assert/strict';
import { ImportBusyError, MAX_ITEM_TEXT, NO_IMPORT_COUNTS } from '../ports/import-repo.js';
import type { ImportRecord, ImportRepo, ImportStatus, NewImportedPage } from '../ports/import-repo.js';

/** What a case needs besides the repository: a way to make an import row (the routes of M7-T05 own creation) and a tenant that is not the one used. */
export interface ImportRepoHarness {
  readonly repo: ImportRepo;
  readonly tenantId: string;
  readonly otherTenantId: string;
  /** A user that exists, as the importer of a written page. */
  readonly userId: string;
  /** `createdAt` (milliseconds) is when the row was made: now when absent. */
  seed(status: ImportStatus, createdAt?: number): Promise<ImportRecord>;
  /** Sets the status of a seeded import (a cancel, which the routes of M7-T05 own). */
  seedStatus(id: string, status: ImportStatus): Promise<void>;
  readonly now: number;
  /** A collection of the tenant, for `create` (in a database it is a row that exists). */
  readonly collectionId: string;
}

export interface ImportRepoCase { readonly name: string; run(h: ImportRepoHarness): Promise<void> }

const limits = { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 };
const content = { state: new Uint8Array([1, 2, 3]), markdown: 'Hello\n', text: 'Hello', hash: Buffer.alloc(32, 1) };
const pageOf = (h: ImportRepoHarness, itemId: string, over: Partial<NewImportedPage> = {}): NewImportedPage => ({
  itemId, collectionId: 'c', parentId: null, position: (before) => `${before ?? ''}a`, title: 'T', createdBy: h.userId, content, markdownBytes: 6, stateBytes: 3, attachments: [], ...over,
});

const pages = (...paths: string[]) => paths.map((path) => ({ path, kind: 'page' as const }));

export const importRepoConformance: readonly ImportRepoCase[] = [
  {
    name: 'start-sets-running-and-started-at-once',
    async run(h) {
      const made = await h.seed('uploaded');
      const first = await h.repo.start(h.tenantId, made.id, h.now);
      assert.equal(first?.status, 'running');
      assert.equal(first?.startedAt, h.now);
      const again = await h.repo.start(h.tenantId, made.id, h.now + 5000);
      assert.equal(again?.status, 'running');
      assert.equal(again?.startedAt, h.now, 'a resumed run keeps the time it first started');
    },
  },
  {
    name: 'start-leaves-any-other-status-alone',
    async run(h) {
      for (const status of ['created', 'cancelled', 'done', 'failed'] as const) {
        const made = await h.seed(status);
        assert.equal(await h.repo.start(h.tenantId, made.id, h.now), undefined, status);
        assert.equal((await h.repo.get(h.tenantId, made.id))?.status, status);
      }
    },
  },
  {
    name: 'add-items-keeps-the-first-row-of-a-path',
    async run(h) {
      const made = await h.seed('running');
      assert.equal(await h.repo.addItems(h.tenantId, made.id, pages('a.md', 'b.md')), 2);
      assert.equal(await h.repo.addItems(h.tenantId, made.id, [...pages('b.md', 'c.md'), { path: 'a.md', kind: 'attachment' }]), 1, 'only c.md is new');
      const items = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.deepEqual(items.map((i) => i.path), ['a.md', 'b.md', 'c.md']);
      assert.deepEqual(await h.repo.pending(h.tenantId, made.id, 'attachment', 10), [], 'the second a.md did not replace the first');
      const first = items[0];
      assert.ok(typeof first?.pageId === 'string' && first.pageId !== '' && typeof first.urlId === 'string' && first.urlId !== '', 'a pending page item has both ids');
      assert.deepEqual(first, { id: first.id, path: 'a.md', kind: 'page', status: 'pending', pageId: first.pageId, urlId: first.urlId, message: null, markdownBytes: null, stateBytes: null, attempts: 0, warnings: 0, remoteImageFailures: {} });
    },
  },
  {
    name: 'an-items-warnings-are-kept-on-its-row-when-it-is-written-or-settled',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, pages('a.md', 'b.md', 'c.md'));
      const [a, b, c] = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.ok(a && b && c);
      assert.equal(a.warnings, 0);
      const out = await h.repo.writePage(h.tenantId, made.id, pageOf(h, a.id, { collectionId: made.targetCollectionId, warnings: 3 }), limits, h.now);
      assert.equal(out.kind, 'ok');
      await h.repo.settle(h.tenantId, made.id, b.id, { status: 'failed', message: 'internal', warnings: 2 });
      await h.repo.settle(h.tenantId, made.id, c.id, { status: 'skipped', message: 'too_large' });
      const rows = await h.repo.scanItems(h.tenantId, made.id, { limit: 10 });
      assert.deepEqual(rows.map((i) => [i.path, i.warnings]), [['a.md', 3], ['b.md', 2], ['c.md', 0]]);
    },
  },
  {
    name: 'write-page-settles-the-file-items-it-names-in-the-same-call',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, [{ path: 'p.md', kind: 'page' }, { path: 'q.md', kind: 'page' }, { path: 'f.png', kind: 'attachment' }, { path: 'g.png', kind: 'attachment' }]);
      const [p, q] = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      const [f, g] = await h.repo.pending(h.tenantId, made.id, 'attachment', 10);
      assert.ok(p && q && f && g);
      // A page item named as a file item is left alone (only a pending file item is settled), and a file not named stays pending.
      const out = await h.repo.writePage(h.tenantId, made.id, pageOf(h, p.id, { collectionId: made.targetCollectionId, attachmentItemIds: [f.id, q.id] }), limits, h.now);
      assert.equal(out.kind, 'ok');
      assert.equal((await h.repo.getItem(h.tenantId, made.id, f.id))?.status, 'ok');
      assert.equal((await h.repo.getItem(h.tenantId, made.id, g.id))?.status, 'pending');
      assert.equal((await h.repo.getItem(h.tenantId, made.id, q.id))?.status, 'pending');
    },
  },
  {
    name: 'a-file-item-can-be-settled-ok-and-a-page-item-cannot',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, [{ path: 'p.md', kind: 'page' }, { path: 'f.png', kind: 'attachment' }]);
      const [page] = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      const [file] = await h.repo.pending(h.tenantId, made.id, 'attachment', 10);
      assert.ok(page && file);
      assert.equal(await h.repo.settle(h.tenantId, made.id, page.id, { status: 'ok', message: '' }), false, 'a page becomes ok only through writePage');
      assert.equal((await h.repo.getItem(h.tenantId, made.id, page.id))?.status, 'pending');
      assert.equal(await h.repo.settle(h.tenantId, made.id, file.id, { status: 'ok', message: '' }), true);
      const done = await h.repo.getItem(h.tenantId, made.id, file.id);
      assert.deepEqual([done?.status, done?.message, done?.pageId], ['ok', null, null]);
      assert.equal(await h.repo.settle(h.tenantId, made.id, file.id, { status: 'skipped', message: 'unreferenced' }), false, 'it is no longer pending');
    },
  },
  {
    name: 'the-reasons-remote-images-failed-are-kept-with-the-warnings',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, pages('a.md', 'b.md', 'c.md'));
      const [a, b, c] = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.ok(a && b && c);
      const out = await h.repo.writePage(h.tenantId, made.id, pageOf(h, a.id, { collectionId: made.targetCollectionId, warnings: 3, remoteImageFailures: { timeout: 2, scheme: 1 } }), limits, h.now);
      assert.equal(out.kind, 'ok');
      await h.repo.settle(h.tenantId, made.id, b.id, { status: 'failed', message: 'invalid-markdown', warnings: 1, remoteImageFailures: { blocked_address: 1 } });
      await h.repo.settle(h.tenantId, made.id, c.id, { status: 'skipped', message: 'too_large' });
      const rows = await h.repo.scanItems(h.tenantId, made.id, { limit: 10 });
      assert.deepEqual(rows.map((i) => [i.path, i.warnings, i.remoteImageFailures]), [['a.md', 3, { timeout: 2, scheme: 1 }], ['b.md', 1, { blocked_address: 1 }], ['c.md', 0, {}]]);
    },
  },
  {
    name: 'a-settled-page-item-has-no-page-and-so-no-ids',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, pages('a.md', 'b.md'));
      const [a, b] = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.ok(a && b);
      assert.ok(a.pageId !== null && a.urlId !== null);
      await h.repo.settle(h.tenantId, made.id, a.id, { status: 'failed', message: 'content-lost' });
      await h.repo.settle(h.tenantId, made.id, b.id, { status: 'skipped', message: 'too_large' });
      for (const i of [a, b]) {
        const row = await h.repo.getItem(h.tenantId, made.id, i.id);
        assert.deepEqual([row?.pageId, row?.urlId], [null, null], i.path);
      }
    },
  },
  {
    name: 'scan-items-pages-through-every-item-by-id',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, [...pages('a.md', 'b.md', 'c.md'), { path: 'x', kind: 'other', status: 'skipped', message: 'ignored' }]);
      const [a] = await h.repo.pending(h.tenantId, made.id, 'page', 1);
      assert.ok(a);
      await h.repo.settle(h.tenantId, made.id, a.id, { status: 'failed', message: 'internal' });
      const seen: string[] = [];
      let after: string | undefined;
      for (;;) {
        const batch = await h.repo.scanItems(h.tenantId, made.id, after === undefined ? { limit: 3 } : { limit: 3, afterId: after });
        if (batch.length === 0) break;
        seen.push(...batch.map((i) => i.path));
        after = batch.at(-1)?.id;
      }
      assert.deepEqual(seen, ['a.md', 'b.md', 'c.md', 'x'], 'pending, settled and skipped alike, once each');
      assert.deepEqual(await h.repo.scanItems(h.otherTenantId, made.id, { limit: 10 }), []);
    },
  },
  {
    name: 'an-added-items-message-is-kept-as-given-and-null-only-when-absent',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, [
        { path: 'a', kind: 'other', status: 'skipped', message: '' }, { path: 'b', kind: 'other', status: 'skipped', message: 'ignored' }, { path: 'c', kind: 'other', status: 'skipped' },
      ]);
      const rows = await h.repo.scanItems(h.tenantId, made.id, { limit: 10 });
      assert.deepEqual(rows.map((i) => i.message), ['', 'ignored', null]);
    },
  },
  {
    name: 'a-pending-page-item-gets-its-page-id-and-url-id-when-it-is-added',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, [...pages('a.md', 'b.md'), { path: 'img/x.png', kind: 'attachment' }, { path: 'c.md', kind: 'page', status: 'skipped', message: 'too_large' }]);
      const items = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.equal(items.length, 2);
      for (const i of items) assert.ok(typeof i.pageId === 'string' && typeof i.urlId === 'string' && i.pageId !== '' && i.urlId !== '', i.path);
      assert.equal(new Set(items.flatMap((i) => [i.pageId, i.urlId])).size, 4, 'every id is distinct');
      const [file] = await h.repo.pending(h.tenantId, made.id, 'attachment', 10);
      assert.deepEqual([file?.pageId, file?.urlId], [null, null], 'only a page has ids');
      // The ids are known before the page is written, so a link to a page that comes later can point at it; they do not change.
      const again = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.deepEqual(again.map((i) => [i.pageId, i.urlId]), items.map((i) => [i.pageId, i.urlId]));
    },
  },
  {
    name: 'a-pending-database-item-gets-its-page-id-and-url-id-too-it-becomes-a-page',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, [{ path: 'Tasks 0123456789abcdef0123456789abcdef_all.csv', kind: 'database_csv' }, { path: 'Notes.csv', kind: 'attachment' }]);
      const [database] = await h.repo.pending(h.tenantId, made.id, 'database_csv', 10);
      assert.ok(typeof database?.pageId === 'string' && database.pageId !== '' && typeof database.urlId === 'string' && database.urlId !== '', 'a database item has the ids of the page it becomes');
      const [file] = await h.repo.pending(h.tenantId, made.id, 'attachment', 10);
      assert.deepEqual([file?.pageId, file?.urlId], [null, null]);
    },
  },
  {
    name: 'an-item-can-be-added-already-skipped-or-failed',
    async run(h) {
      const made = await h.seed('running');
      const added = await h.repo.addItems(h.tenantId, made.id, [
        { path: '__MACOSX/a', kind: 'other', status: 'skipped', message: 'ignored' }, { path: 'bad', kind: 'other', status: 'failed', message: 'bad_name' }, { path: 'p.md', kind: 'page' },
      ]);
      assert.equal(added, 3);
      assert.deepEqual((await h.repo.pending(h.tenantId, made.id, 'page', 10)).map((i) => i.path), ['p.md']);
      assert.deepEqual(await h.repo.pending(h.tenantId, made.id, 'other', 10), [], 'neither is pending');
      const listed = await h.repo.scanItems(h.tenantId, made.id, { limit: 10 });
      assert.deepEqual(listed.map((i) => [i.path, i.status, i.message]), [['__MACOSX/a', 'skipped', 'ignored'], ['bad', 'failed', 'bad_name'], ['p.md', 'pending', null]]);
      assert.equal(listed[0]?.pageId, null);
    },
  },
  {
    name: 'pending-is-parents-before-children-and-limited',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, [...pages('z.md', 'b/c.md', 'a.md', 'b/c/d.md', 'b.md'), { path: 'img/x.png', kind: 'attachment' }]);
      assert.deepEqual((await h.repo.pending(h.tenantId, made.id, 'page', 10)).map((i) => i.path), ['a.md', 'b.md', 'z.md', 'b/c.md', 'b/c/d.md']);
      assert.deepEqual((await h.repo.pending(h.tenantId, made.id, 'page', 2)).map((i) => i.path), ['a.md', 'b.md']);
      assert.deepEqual((await h.repo.pending(h.tenantId, made.id, 'attachment', 10)).map((i) => i.path), ['img/x.png']);
    },
  },
  {
    name: 'settle-ends-a-pending-item-once',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, pages('a.md', 'b.md'));
      const [a] = await h.repo.pending(h.tenantId, made.id, 'page', 1);
      assert.ok(a);
      assert.equal(await h.repo.settle(h.tenantId, made.id, a.id, { status: 'skipped', message: 'too_large', markdownBytes: 2_000_000 }), true);
      assert.equal(await h.repo.settle(h.tenantId, made.id, a.id, { status: 'failed', message: 'internal' }), false, 'it is no longer pending');
      assert.deepEqual((await h.repo.pending(h.tenantId, made.id, 'page', 10)).map((i) => i.path), ['b.md']);
    },
  },
  {
    name: 'a-path-is-kept-exactly-and-a-message-is-cut-and-cleaned',
    async run(h) {
      const made = await h.seed('running');
      const long = `${'x'.repeat(MAX_ITEM_TEXT + 50)}.md`;
      const odd = ['a\u0001b.md', 'ab.md', `${'y'.repeat(MAX_ITEM_TEXT)}1.md`, `${'y'.repeat(MAX_ITEM_TEXT)}2.md`];
      // The path is the key of the entry in the archive (links resolve to it): never cut or cleaned, so entries that differ late or only by a control character stay two rows.
      assert.equal(await h.repo.addItems(h.tenantId, made.id, pages(long, ...odd)), 5);
      const items = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.deepEqual(items.map((i) => i.path).sort(), [long, ...odd].sort());
      const first = items[0];
      assert.ok(first);
      // What is shown is cut and cleaned: a message is stored at most MAX_ITEM_TEXT characters long, without control characters.
      await h.repo.settle(h.tenantId, made.id, first.id, { status: 'failed', message: `bad\u0007${'m'.repeat(400)}` });
      const settled = await h.repo.getItem(h.tenantId, made.id, first.id);
      assert.equal(settled?.status, 'failed');
      assert.equal(settled?.message, `bad${'m'.repeat(MAX_ITEM_TEXT - 3)}`);
    },
  },
  {
    name: 'counts-and-finish-only-for-a-running-import',
    async run(h) {
      const made = await h.seed('running');
      const counts = { ...NO_IMPORT_COUNTS, pagesTotal: 3, pagesDone: 1, warnings: 2 };
      assert.equal(await h.repo.setCounts(h.tenantId, made.id, counts), true);
      assert.deepEqual((await h.repo.get(h.tenantId, made.id))?.counts, counts);
      assert.equal(await h.repo.finish(h.tenantId, made.id, 'done', null, h.now + 9), true);
      const done = await h.repo.get(h.tenantId, made.id);
      assert.equal(done?.status, 'done');
      assert.equal(done?.finishedAt, h.now + 9);
      assert.equal(await h.repo.finish(h.tenantId, made.id, 'failed', 'internal', h.now + 10), false, 'it already ended');
      assert.equal(await h.repo.setCounts(h.tenantId, made.id, NO_IMPORT_COUNTS), false);
      assert.deepEqual((await h.repo.get(h.tenantId, made.id))?.counts, counts, 'an ended import keeps its counts');
    },
  },
  {
    name: 'write-page-settles-its-item-once',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, pages('a.md'));
      const [item] = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.ok(item);
      const first = await h.repo.writePage(h.tenantId, made.id, pageOf(h, item.id, { collectionId: made.targetCollectionId }), limits, h.now);
      assert.equal(first.kind, 'ok');
      if (first.kind !== 'ok') return;
      assert.deepEqual([first.pageId, first.urlId], [item.pageId, item.urlId], 'the page is written under the ids the item was given, so links made before it was written hold');
      const settled = await h.repo.getItem(h.tenantId, made.id, item.id);
      assert.deepEqual({ ...settled }, { ...item, status: 'ok', pageId: first.pageId, urlId: first.urlId, markdownBytes: 6, stateBytes: 3 });
      assert.deepEqual(await h.repo.pending(h.tenantId, made.id, 'page', 10), []);
      const again = await h.repo.writePage(h.tenantId, made.id, pageOf(h, item.id, { collectionId: made.targetCollectionId }), limits, h.now);
      assert.deepEqual(again, { kind: 'not-pending' }, 'a resumed run does not write the page twice');
    },
  },
  {
    name: 'write-page-only-while-the-import-runs',
    async run(h) {
      for (const status of ['cancelled', 'done', 'failed'] as const) {
        const made = await h.seed('running');
        await h.repo.addItems(h.tenantId, made.id, pages('a.md'));
        const [item] = await h.repo.pending(h.tenantId, made.id, 'page', 10);
        assert.ok(item);
        if (status === 'cancelled') await h.seedStatus(made.id, 'cancelled');
        else await h.repo.finish(h.tenantId, made.id, status === 'done' ? 'done' : 'failed', null, h.now);
        assert.deepEqual(await h.repo.writePage(h.tenantId, made.id, pageOf(h, item.id, { collectionId: made.targetCollectionId }), limits, h.now), { kind: 'not-running' }, status);
        assert.equal((await h.repo.getItem(h.tenantId, made.id, item.id))?.status, 'pending');
      }
    },
  },
  {
    name: 'write-page-in-another-tenant-writes-nothing',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, pages('a.md'));
      const [item] = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.ok(item);
      const result = await h.repo.writePage(h.otherTenantId, made.id, pageOf(h, item.id, { collectionId: made.targetCollectionId }), limits, h.now);
      assert.notEqual(result.kind, 'ok');
      assert.equal((await h.repo.getItem(h.tenantId, made.id, item.id))?.status, 'pending');
    },
  },
  {
    name: 'a-cancelled-import-stays-cancelled',
    async run(h) {
      const made = await h.seed('cancelled');
      assert.equal(await h.repo.finish(h.tenantId, made.id, 'done', null, h.now), false);
      assert.equal((await h.repo.get(h.tenantId, made.id))?.status, 'cancelled');
    },
  },
  {
    name: 'failed-finish-keeps-the-error-code',
    async run(h) {
      const made = await h.seed('running');
      assert.equal(await h.repo.finish(h.tenantId, made.id, 'failed', 'job_failed', h.now), true);
      assert.deepEqual(await h.repo.get(h.tenantId, made.id).then((r) => [r?.status, r?.error]), ['failed', 'job_failed']);
    },
  },
  {
    name: 'another-tenants-import-is-not-found-and-not-touched',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, pages('a.md'));
      const other = h.otherTenantId;
      assert.equal(await h.repo.get(other, made.id), undefined);
      assert.equal(await h.repo.addItems(other, made.id, pages('x.md')), 0);
      assert.deepEqual(await h.repo.pending(other, made.id, 'page', 10), []);
      assert.equal(await h.repo.start(other, made.id, h.now), undefined);
      assert.equal(await h.repo.setCounts(other, made.id, NO_IMPORT_COUNTS), false);
      assert.equal(await h.repo.finish(other, made.id, 'done', null, h.now), false);
      const [item] = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.ok(item);
      assert.equal(await h.repo.settle(other, made.id, item.id, { status: 'failed', message: 'x' }), false);
      assert.equal(await h.repo.getItem(other, made.id, item.id), undefined);
      assert.deepEqual((await h.repo.pending(h.tenantId, made.id, 'page', 10)).map((i) => i.path), ['a.md']);
      assert.equal((await h.repo.get(h.tenantId, made.id))?.status, 'running');
    },
  },
  {
    name: 'create-makes-a-created-import-with-its-size-and-key',
    async run(h) {
      const made = await h.repo.create(h.tenantId, { id: '00000000-0000-4000-8000-0000000000c1', targetCollectionId: h.collectionId, createdBy: h.userId, source: 'markdown_zip', bytes: 1234, s3Key: 'tenants/t/imports/c1/source.zip' });
      assert.equal(made.status, 'created');
      assert.equal(made.bytes, 1234);
      assert.equal(made.s3Key, 'tenants/t/imports/c1/source.zip');
      assert.equal(made.createdBy, h.userId);
      assert.equal(made.targetCollectionId, h.collectionId);
      assert.deepEqual(await h.repo.get(h.tenantId, made.id), made);
      assert.equal(await h.repo.get(h.otherTenantId, made.id), undefined);
    },
  },
  {
    name: 'mark-uploaded-moves-a-created-or-uploaded-import-only',
    async run(h) {
      const created = await h.seed('created');
      assert.equal(await h.repo.markUploaded(h.tenantId, created.id), true);
      assert.equal((await h.repo.get(h.tenantId, created.id))?.status, 'uploaded');
      assert.equal(await h.repo.markUploaded(h.tenantId, created.id), true, 'again: still uploaded');
      for (const status of ['running', 'done', 'failed', 'cancelled'] as const) {
        const made = await h.seed(status);
        assert.equal(await h.repo.markUploaded(h.tenantId, made.id), false, status);
        assert.equal((await h.repo.get(h.tenantId, made.id))?.status, status);
      }
      assert.equal(await h.repo.markUploaded(h.otherTenantId, created.id), false);
    },
  },
  {
    name: 'a-tenant-has-one-running-import-at-a-time',
    async run(h) {
      const first = await h.seed('uploaded');
      const second = await h.seed('uploaded');
      assert.equal((await h.repo.start(h.tenantId, first.id, h.now))?.status, 'running');
      await assert.rejects(() => h.repo.start(h.tenantId, second.id, h.now), ImportBusyError);
      assert.equal((await h.repo.get(h.tenantId, second.id))?.status, 'uploaded', 'the later import waits as it was');
      assert.equal((await h.repo.start(h.tenantId, first.id, h.now + 1))?.status, 'running', 'the running one may be started again (a resumed run)');
      assert.ok(await h.repo.cancel(h.tenantId, first.id, h.now));
      assert.equal((await h.repo.start(h.tenantId, second.id, h.now))?.status, 'running', 'when the first has ended the second may run');
    },
  },
  {
    name: 'two-starts-at-once-leave-one-running',
    async run(h) {
      const a = await h.seed('uploaded');
      const b = await h.seed('uploaded');
      const results = await Promise.allSettled([h.repo.start(h.tenantId, a.id, h.now), h.repo.start(h.tenantId, b.id, h.now)]);
      assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert.ok(rejected?.reason instanceof ImportBusyError);
      const states = [(await h.repo.get(h.tenantId, a.id))?.status, (await h.repo.get(h.tenantId, b.id))?.status].sort();
      assert.deepEqual(states, ['running', 'uploaded'], 'one runs and the other waits');
    },
  },
  {
    name: 'list-items-is-the-settled-ones-in-id-order-after-a-cursor',
    async run(h) {
      const made = await h.seed('running');
      const paths = Array.from({ length: 12 }, (_, n) => `d/${String(n).padStart(2, '0')}.md`);
      await h.repo.addItems(h.tenantId, made.id, pages(...paths));
      const all = [...(await h.repo.pending(h.tenantId, made.id, 'page', 50))];
      assert.equal(all.length, 12);
      assert.deepEqual(await h.repo.listItems(h.tenantId, made.id, { limit: 50 }), [], 'none is settled yet: pending ones are not listed');
      for (const [n, item] of all.entries()) if (n !== 5) assert.ok(await h.repo.settle(h.tenantId, made.id, item.id, { status: n % 2 === 0 ? 'skipped' : 'failed', message: 'too_large' }));
      const listed = await h.repo.listItems(h.tenantId, made.id, { limit: 50 });
      assert.equal(listed.length, 11, 'the pending one is left out');
      const ids = listed.map((i) => BigInt(i.id));
      assert.deepEqual([...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)), ids, 'ascending by id as a number (10 after 9)');
      const first = await h.repo.listItems(h.tenantId, made.id, { limit: 4 });
      assert.equal(first.length, 4);
      const next = await h.repo.listItems(h.tenantId, made.id, { limit: 4, afterId: first[3]!.id });
      assert.deepEqual([...first, ...next].map((i) => i.id), listed.slice(0, 8).map((i) => i.id));
      assert.deepEqual(await h.repo.listItems(h.tenantId, made.id, { limit: 4, afterId: listed[10]!.id }), []);
      assert.deepEqual(await h.repo.listItems(h.otherTenantId, made.id, { limit: 50 }), []);
    },
  },
  {
    name: 'cancel-ends-a-running-or-waiting-import-only',
    async run(h) {
      const made = await h.seed('uploaded');
      assert.equal((await h.repo.start(h.tenantId, made.id, h.now))?.status, 'running');
      assert.equal(await h.repo.cancel(h.otherTenantId, made.id, h.now), undefined);
      const cancelled = await h.repo.cancel(h.tenantId, made.id, h.now + 9);
      assert.equal(cancelled?.status, 'cancelled');
      assert.equal(cancelled?.finishedAt, h.now + 9);
      assert.equal(await h.repo.cancel(h.tenantId, made.id, h.now + 20), undefined, 'cancelled already');
      assert.equal(await h.repo.setCounts(h.tenantId, made.id, NO_IMPORT_COUNTS), false);
      for (const status of ['created', 'done', 'failed'] as const) {
        const other = await h.seed(status);
        assert.equal(await h.repo.cancel(h.tenantId, other.id, h.now), undefined, status);
        assert.equal((await h.repo.get(h.tenantId, other.id))?.status, status);
      }
      // An import that waits for its turn (accepted, `uploaded`, while another of the tenant runs) can be withdrawn: it never runs.
      const waiting = await h.seed('uploaded');
      const withdrawn = await h.repo.cancel(h.tenantId, waiting.id, h.now + 3);
      assert.equal(withdrawn?.status, 'cancelled');
      assert.equal(withdrawn?.finishedAt, h.now + 3);
      assert.equal(await h.repo.start(h.tenantId, waiting.id, h.now), undefined, 'a cancelled import is not started');
    },
  },
  {
    name: 'running-lists-the-running-import-of-the-tenant-only',
    async run(h) {
      assert.deepEqual(await h.repo.running(h.tenantId), []);
      await h.seed('uploaded');
      await h.seed('done');
      const made = await h.seed('running');
      assert.deepEqual(await h.repo.running(h.tenantId), [made.id]);
      assert.deepEqual(await h.repo.running(h.otherTenantId), []);
      await h.seedStatus(made.id, 'failed');
      assert.deepEqual(await h.repo.running(h.tenantId), []);
    },
  },
  {
    name: 'stale-lists-unfinished-uploads-created-at-or-before-the-cutoff-oldest-first',
    async run(h) {
      const hour = 3_600_000;
      const newer = await h.seed('uploaded', h.now - 25 * hour);
      const older = await h.seed('created', h.now - 30 * hour);
      await h.seed('uploaded', h.now - 2 * hour); // too young
      await h.seed('done', h.now - 99 * hour); // not an unfinished upload
      await h.seed('failed', h.now - 99 * hour);
      await h.seed('cancelled', h.now - 99 * hour);
      const cutoff = h.now - 24 * hour;
      assert.deepEqual(await h.repo.stale(h.tenantId, cutoff, 10), [older.id, newer.id]);
      assert.deepEqual(await h.repo.stale(h.tenantId, cutoff, 1), [older.id]);
      assert.deepEqual(await h.repo.stale(h.tenantId, h.now - 30 * hour - 1, 10), [], 'the cutoff is inclusive of nothing older than itself');
      assert.deepEqual(await h.repo.stale(h.otherTenantId, cutoff, 10), []);
    },
  },
  {
    name: 'abandon-fails-an-unfinished-upload-once-and-leaves-any-other-status-alone',
    async run(h) {
      for (const status of ['created', 'uploaded'] as const) {
        const made = await h.seed(status);
        assert.equal(await h.repo.abandon(h.tenantId, made.id, h.now + 7), true, status);
        const row = await h.repo.get(h.tenantId, made.id);
        assert.deepEqual([row?.status, row?.error, row?.finishedAt], ['failed', 'abandoned', h.now + 7], status);
        assert.equal(await h.repo.abandon(h.tenantId, made.id, h.now + 99), false, 'a second call changes nothing');
        assert.equal((await h.repo.get(h.tenantId, made.id))?.finishedAt, h.now + 7);
      }
      const mine = await h.seed('created');
      assert.equal(await h.repo.abandon(h.otherTenantId, mine.id, h.now), false, 'another tenant cannot');
      assert.equal((await h.repo.get(h.tenantId, mine.id))?.status, 'created');
      for (const status of ['running', 'done', 'cancelled', 'failed'] as const) {
        const made = await h.seed(status);
        assert.equal(await h.repo.abandon(h.tenantId, made.id, h.now), false, status);
        assert.equal((await h.repo.get(h.tenantId, made.id))?.status, status);
      }
    },
  },
  {
    name: 'trash-imported-moves-the-pages-of-ok-page-items-once',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, [...pages('a.md', 'b.md', 'c.md', 'd.md'), { path: 'img.png', kind: 'attachment' as const }]);
      const items = await h.repo.pending(h.tenantId, made.id, 'page', 10);
      assert.equal(items.length, 4);
      for (const item of items.slice(0, 2)) assert.equal((await h.repo.writePage(h.tenantId, made.id, pageOf(h, item.id, { collectionId: made.targetCollectionId }), limits, h.now)).kind, 'ok');
      await h.repo.settle(h.tenantId, made.id, items[2]!.id, { status: 'failed', message: 'too big' });
      await h.repo.settle(h.tenantId, made.id, items[3]!.id, { status: 'skipped', message: 'ignored' });
      await h.seedStatus(made.id, 'cancelled');
      const first = await h.repo.trashImported(h.tenantId, made.id);
      assert.equal(first?.pages, 2, 'the two written pages; a failed or skipped item has none');
      assert.equal(first?.batches.length, 2, 'each imported root is a batch of its own');
      assert.deepEqual(await h.repo.trashImported(h.tenantId, made.id), { batches: [], pages: 0 }, 'a second call finds nothing left to move');
    },
  },
  {
    name: 'trash-imported-moves-a-written-database-page-too',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, [{ path: 'Tasks 0123456789abcdef0123456789abcdef_all.csv', kind: 'database_csv' }]);
      const [database] = await h.repo.pending(h.tenantId, made.id, 'database_csv', 10);
      assert.equal((await h.repo.writePage(h.tenantId, made.id, pageOf(h, database!.id, { collectionId: made.targetCollectionId }), limits, h.now)).kind, 'ok');
      await h.seedStatus(made.id, 'cancelled');
      assert.deepEqual(await h.repo.trashImported(h.tenantId, made.id).then((r) => r?.pages), 1, 'a database page at the root is an imported page like any other (decision 167)');
    },
  },
  {
    name: 'trash-imported-finds-only-the-import-of-the-tenant',
    async run(h) {
      const made = await h.seed('cancelled');
      assert.equal(await h.repo.trashImported(h.otherTenantId, made.id), undefined);
      assert.equal(await h.repo.trashImported(h.tenantId, '00000000-0000-4000-8000-000000000000'), undefined);
      assert.deepEqual(await h.repo.trashImported(h.tenantId, made.id), { batches: [], pages: 0 }, 'an import with no pages is found, and has nothing to move');
    },
  },
  {
    name: 'trash-imported-names-one-batch-for-each-outermost-imported-page',
    async run(h) {
      const made = await h.seed('running');
      await h.repo.addItems(h.tenantId, made.id, pages('a.md', 'a/b.md', 'a/b/c.md', 'z.md'));
      const items = new Map((await h.repo.pending(h.tenantId, made.id, 'page', 10)).map((i) => [i.path, i]));
      const write = async (path: string, parentId: string | null) => {
        const item = items.get(path)!;
        const out = await h.repo.writePage(h.tenantId, made.id, pageOf(h, item.id, { collectionId: made.targetCollectionId, parentId }), limits, h.now);
        assert.equal(out.kind, 'ok', path);
        return out.kind === 'ok' ? out.pageId : '';
      };
      const a = await write('a.md', null);
      const b = await write('a/b.md', a);
      await write('a/b/c.md', b);
      const z = await write('z.md', null);
      await h.seedStatus(made.id, 'failed');
      const moved = await h.repo.trashImported(h.tenantId, made.id);
      assert.equal(moved?.pages, 4);
      assert.deepEqual([...(moved?.batches ?? [])].sort(), [a, z].sort(), 'a page under another imported page is in the subtree of its outermost imported ancestor');
    },
  },
  {
    name: 'ended-lists-imports-that-ended-since-a-time-by-id',
    async run(h) {
      const one = await h.seed('running');
      assert.equal(await h.repo.finish(h.tenantId, one.id, 'done', null, h.now), true);
      const two = await h.seed('running');
      assert.equal(await h.repo.finish(h.tenantId, two.id, 'failed', 'x', h.now - 5000), true);
      const three = await h.seed('running');
      assert.ok(await h.repo.cancel(h.tenantId, three.id, h.now));
      await h.seed('running');
      await h.seed('uploaded');
      const all = await h.repo.ended(h.tenantId, { since: 0, limit: 10 });
      assert.deepEqual(all.map((r) => r.status).sort(), ['cancelled', 'done', 'failed']);
      assert.deepEqual(all.map((r) => r.id), [...all.map((r) => r.id)].sort());
      const first = await h.repo.ended(h.tenantId, { since: 0, limit: 1 });
      assert.equal(first.length, 1);
      const rest = await h.repo.ended(h.tenantId, { since: 0, afterId: first[0]!.id, limit: 10 });
      assert.deepEqual([...first, ...rest].map((r) => r.id), all.map((r) => r.id));
      assert.deepEqual((await h.repo.ended(h.tenantId, { since: h.now - 1000, limit: 10 })).map((r) => r.status).sort(), ['cancelled', 'done'], 'the one that ended earlier is left out');
      assert.deepEqual(await h.repo.ended(h.otherTenantId, { since: 0, limit: 10 }), []);
    },
  },
];
