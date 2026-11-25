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
  seed(status: ImportStatus): Promise<ImportRecord>;
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
      assert.deepEqual({ ...items[0], pageId: null, urlId: null }, { id: items[0]?.id, path: 'a.md', kind: 'page', status: 'pending', pageId: null, urlId: null, message: null, markdownBytes: null, stateBytes: null, attempts: 0 });
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
];
