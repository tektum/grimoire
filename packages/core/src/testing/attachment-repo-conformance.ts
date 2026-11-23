import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AttachmentRepo, NewPending } from '../ports/attachment-repo.js';

/** What a conformance case needs besides the repository: ids that exist, ids that do not, and a fixed `now`. */
export interface AttachmentRepoHarness {
  readonly repo: AttachmentRepo;
  readonly pageId: string;
  readonly userId: string;
  readonly otherUserId: string;
  /** A user no other case uses, so that the cap of the parallel case counts only its own rows. */
  readonly parallelUserId: string;
  readonly missingPageId: string;
  readonly missingUserId: string;
  readonly now: number;
}

export interface AttachmentRepoCase { readonly name: string; run(h: AttachmentRepoHarness): Promise<void> }

const HOUR = 3_600_000;
const pending = (h: AttachmentRepoHarness, over: Partial<NewPending> = {}): NewPending => {
  const id = randomUUID();
  return { id, pageId: h.pageId, uploaderId: h.userId, fileName: 'a.png', contentType: 'image/png', size: 10, key: `attachments/${id}`, expiresAt: h.now + HOUR, ...over };
};

export const attachmentRepoCaseNames = [
  'create-and-read', 'cap-counts-live-pending-rows-only', 'parallel-creates-respect-the-cap', 'refuses-a-missing-page-or-user', 'mark-ready', 'remove', 'expired-pending', 'insert-ready',
] as const;

export const attachmentRepoConformance: readonly AttachmentRepoCase[] = [
  {
    name: 'create-and-read',
    async run(h) {
      const made = await h.repo.createPending(pending(h, { fileName: 'r\u00e9sum\u00e9.pdf', contentType: 'application/pdf', size: 1234 }), 10, h.now);
      assert.equal(made.kind, 'created');
      if (made.kind !== 'created') return;
      assert.deepEqual(
        { ...made.row, createdAt: 0 },
        { id: made.row.id, pageId: h.pageId, uploaderId: h.userId, fileName: 'r\u00e9sum\u00e9.pdf', contentType: 'application/pdf', size: 1234, key: `attachments/${made.row.id}`, status: 'pending', expiresAt: h.now + HOUR, createdAt: 0, readyAt: null },
      );
      assert.deepEqual(await h.repo.get(made.row.id), made.row);
      assert.equal(await h.repo.get(randomUUID()), undefined);
      assert.deepEqual(await h.repo.getMany([made.row.id, randomUUID()]), [made.row]);
      assert.deepEqual(await h.repo.getMany([]), []);
    },
  },
  {
    name: 'cap-counts-live-pending-rows-only',
    async run(h) {
      const user = h.otherUserId; // a user of its own: other cases leave rows behind
      const make = (over: Partial<NewPending> = {}, cap = 3) => h.repo.createPending(pending(h, { uploaderId: user, ...over }), cap, h.now);
      // An expired pending row and a ready row do not count.
      assert.equal((await make({ expiresAt: h.now - 1 })).kind, 'created');
      const ready = await make();
      assert.equal(ready.kind, 'created');
      if (ready.kind === 'created') assert.ok(await h.repo.markReady(ready.row.id, h.now));
      const kinds: string[] = [];
      for (let i = 0; i < 4; i += 1) kinds.push((await make()).kind);
      assert.deepEqual(kinds, ['created', 'created', 'created', 'cap']);
      // Another user is not held by this one's cap, and a larger cap lets one more in.
      assert.equal((await h.repo.createPending(pending(h), 3, h.now)).kind, 'created');
      assert.equal((await make({}, 4)).kind, 'created');
      // A row at exactly `now` is expired: the count is of rows that expire after it.
      assert.equal((await h.repo.createPending(pending(h, { uploaderId: user, expiresAt: h.now + 1 }), 100, h.now)).kind, 'created');
    },
  },
  {
    name: 'parallel-creates-respect-the-cap',
    async run(h) {
      const results = await Promise.all(Array.from({ length: 20 }, () => h.repo.createPending(pending(h, { uploaderId: h.parallelUserId }), 10, h.now)));
      const created = results.filter((r) => r.kind === 'created').length;
      const capped = results.filter((r) => r.kind === 'cap').length;
      assert.deepEqual([created, capped], [10, 10]);
    },
  },
  {
    name: 'refuses-a-missing-page-or-user',
    async run(h) {
      assert.deepEqual(await h.repo.createPending(pending(h, { pageId: h.missingPageId }), 10, h.now), { kind: 'no-page' });
      assert.deepEqual(await h.repo.createPending(pending(h, { uploaderId: h.missingUserId }), 10, h.now), { kind: 'no-user' });
    },
  },
  {
    name: 'mark-ready',
    async run(h) {
      const made = await h.repo.createPending(pending(h, { uploaderId: h.otherUserId }), 100, h.now);
      assert.equal(made.kind, 'created');
      if (made.kind !== 'created') return;
      const ready = await h.repo.markReady(made.row.id, h.now + 5);
      assert.deepEqual(ready, { ...made.row, status: 'ready', readyAt: h.now + 5, expiresAt: null });
      assert.deepEqual(await h.repo.get(made.row.id), ready);
      assert.equal(await h.repo.markReady(made.row.id, h.now + 9), undefined, 'a ready row is not made ready again');
      assert.equal(await h.repo.markReady(randomUUID(), h.now), undefined);
    },
  },
  {
    name: 'remove',
    async run(h) {
      const a = await h.repo.createPending(pending(h, { uploaderId: h.otherUserId }), 100, h.now);
      const b = await h.repo.createPending(pending(h, { uploaderId: h.otherUserId }), 100, h.now);
      if (a.kind !== 'created' || b.kind !== 'created') throw new Error('setup');
      assert.equal(await h.repo.removeIfPending(a.row.id), true);
      assert.equal(await h.repo.removeIfPending(a.row.id), false);
      assert.equal(await h.repo.get(a.row.id), undefined);
      await h.repo.markReady(b.row.id, h.now);
      assert.equal(await h.repo.removeIfPending(b.row.id), false, 'a ready row is not removed as a pending one');
      assert.ok(await h.repo.get(b.row.id));
      await h.repo.remove(b.row.id);
      assert.equal(await h.repo.get(b.row.id), undefined);
      await h.repo.remove(b.row.id); // absent is a success
    },
  },
  {
    name: 'expired-pending',
    async run(h) {
      const user = h.otherUserId;
      const t = h.now + 10 * HOUR; // a time of its own, after everything the other cases made
      const make = (expiresAt: number) => h.repo.createPending(pending(h, { uploaderId: user, expiresAt }), 1000, t - 100 * HOUR);
      const [first, second, third, live] = [await make(t - 3000), await make(t - 2000), await make(t - 1000), await make(t + 1000)];
      for (const r of [first, second, third, live]) assert.equal(r.kind, 'created');
      if (first.kind !== 'created' || second.kind !== 'created' || third.kind !== 'created' || live.kind !== 'created') return;
      await h.repo.markReady(third.row.id, t - 500); // a ready row is never listed, whatever its old expiry
      const listed = (await h.repo.expiredPending(t, 100)).filter((r) => [first, second, third, live].some((x) => x.kind === 'created' && x.row.id === r.id));
      assert.deepEqual(listed.map((r) => r.id), [first.row.id, second.row.id]);
      const limited = (await h.repo.expiredPending(t - 2500, 1)).filter((r) => r.id === first.row.id);
      assert.deepEqual(limited.map((r) => r.id), [first.row.id]);
    },
  },
  {
    name: 'insert-ready',
    async run(h) {
      const id = randomUUID();
      const row = await h.repo.insertReady({ id, pageId: h.pageId, uploaderId: null, fileName: 'import.csv', contentType: 'text/csv', size: 77, key: `attachments/${id}`, readyAt: h.now }, undefined);
      assert.deepEqual(row, { id, pageId: h.pageId, uploaderId: null, fileName: 'import.csv', contentType: 'text/csv', size: 77, key: `attachments/${id}`, status: 'ready', expiresAt: null, createdAt: h.now, readyAt: h.now });
      assert.deepEqual(await h.repo.get(id), row);
    },
  },
];
