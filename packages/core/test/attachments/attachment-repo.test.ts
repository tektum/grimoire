import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attachmentRepoCaseNames, attachmentRepoConformance } from '../../src/testing/attachment-repo-conformance.js';
import { FakeAttachmentRepo } from '../../src/testing/fake-attachment-repo.js';
import type { AttachmentRepo, NewReady } from '../../src/ports/attachment-repo.js';
import type { Queryable } from '../../src/ports/database.js';

/** A transaction handle for the in-memory repository, which ignores it. */
const NO_TX: Queryable = { query: () => Promise.resolve([]) };
describe('the in-memory AttachmentRepo meets the conformance cases of the PostgreSQL one', () => {
  it('runs every case', () => {
    expect(attachmentRepoConformance.map((c) => c.name)).toEqual([...attachmentRepoCaseNames]);
  });

  it('a ready row is stored in the transaction of the caller (row-level security: the tenant is set there), so the port has no call without one', () => {
    const port: AttachmentRepo = new FakeAttachmentRepo({ pages: () => true, users: () => true });
    // @ts-expect-error `tx` is required: with no transaction the statement would run with no tenant and fail under row-level security
    const withoutTransaction = (): Promise<unknown> => port.insertReady({} as NewReady);
    expect(typeof withoutTransaction).toBe('function'); // never called: the point is that the line above does not compile without the transaction
  });

  for (const c of attachmentRepoConformance) {
    it(c.name, async () => {
      const missingPageId = randomUUID();
      const missingUserId = randomUUID();
      const repo = new FakeAttachmentRepo({ pages: (id) => id !== missingPageId, users: (id) => id !== missingUserId });
      await c.run({ repo, inTransaction: (fn) => fn(NO_TX), pageId: randomUUID(), userId: randomUUID(), otherUserId: randomUUID(), parallelUserId: randomUUID(), missingPageId, missingUserId, now: 1_700_000_000_000 });
    });
  }
});
