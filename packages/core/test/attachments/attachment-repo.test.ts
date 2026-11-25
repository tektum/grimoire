import { randomUUID } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
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

  // Checked by the compiler (`bun run typecheck`), as `defineRoute` is in apps/server/test/http/factory.test.ts: an optional `tx` would let a call run with no tenant set, which row-level
  // security refuses. That the row is stored in the caller's transaction and goes with its rollback is the PostgreSQL suite's (attachments.int.test.ts) and the `insert-ready` case's.
  it('takes no call without the caller\'s transaction', () => {
    expectTypeOf<Parameters<AttachmentRepo['insertReady']>>().toEqualTypeOf<[NewReady, Queryable]>();
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
