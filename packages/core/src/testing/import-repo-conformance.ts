import assert from 'node:assert/strict';
import { MAX_ITEM_TEXT, NO_IMPORT_COUNTS } from '../ports/import-repo.js';
import type { ImportRecord, ImportRepo, ImportStatus, NewImportedPage } from '../ports/import-repo.js';

/** What a case needs besides the repository: a way to make an import row (the routes of M7-T05 own creation) and a tenant that is not the one used. */
export interface ImportRepoHarness {
  readonly repo: ImportRepo;
  readonly tenantId: string;
  readonly otherTenantId: string;
  seed(status: ImportStatus): Promise<ImportRecord>;
  /** Sets the status of a seeded import (a cancel, which the routes of M7-T05 own). */
  seedStatus(id: string, status: ImportStatus): Promise<void>;
  readonly now: number;
}

export interface ImportRepoCase { readonly name: string; run(h: ImportRepoHarness): Promise<void> }

const limits = { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 };
const content = { state: new Uint8Array([1, 2, 3]), markdown: 'Hello\n', text: 'Hello', hash: Buffer.alloc(32, 1) };
const pageOf = (itemId: string, over: Partial<NewImportedPage> = {}): NewImportedPage => ({
  itemId, collectionId: 'c', parentId: null, position: (before) => `${before ?? ''}a`, title: 'T', createdBy: 'u', content, markdownBytes: 6, stateBytes: 3, attachments: [], ...over,
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
      assert.deepEqual(items[0], { id: items[0]?.id, path: 'a.md', kind: 'page', status: 'pending', pageId: null, urlId: null, message: null, markdownBytes: null, stateBytes: null, attempts: 0 });
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
      const first = await h.repo.writePage(h.tenantId, made.id, pageOf(item.id, { collectionId: made.targetCollectionId }), limits, h.now);
      assert.equal(first.kind, 'ok');
      if (first.kind !== 'ok') return;
      const settled = await h.repo.getItem(h.tenantId, made.id, item.id);
      assert.deepEqual({ ...settled }, { ...item, status: 'ok', pageId: first.pageId, urlId: first.urlId, markdownBytes: 6, stateBytes: 3 });
      assert.deepEqual(await h.repo.pending(h.tenantId, made.id, 'page', 10), []);
      const again = await h.repo.writePage(h.tenantId, made.id, pageOf(item.id, { collectionId: made.targetCollectionId }), limits, h.now);
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
        assert.deepEqual(await h.repo.writePage(h.tenantId, made.id, pageOf(item.id, { collectionId: made.targetCollectionId }), limits, h.now), { kind: 'not-running' }, status);
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
      const result = await h.repo.writePage(h.otherTenantId, made.id, pageOf(item.id, { collectionId: made.targetCollectionId }), limits, h.now);
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
];
