import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attachmentRepoCaseNames, attachmentRepoConformance } from '../../src/testing/attachment-repo-conformance.js';
import { FakeAttachmentRepo } from '../../src/testing/fake-attachment-repo.js';

describe('the in-memory AttachmentRepo meets the conformance cases of the PostgreSQL one', () => {
  it('runs every case', () => {
    expect(attachmentRepoConformance.map((c) => c.name)).toEqual([...attachmentRepoCaseNames]);
  });

  for (const c of attachmentRepoConformance) {
    it(c.name, async () => {
      const missingPageId = randomUUID();
      const missingUserId = randomUUID();
      const repo = new FakeAttachmentRepo({ pages: (id) => id !== missingPageId, users: (id) => id !== missingUserId });
      await c.run({ repo, pageId: randomUUID(), userId: randomUUID(), otherUserId: randomUUID(), parallelUserId: randomUUID(), missingPageId, missingUserId, now: 1_700_000_000_000 });
    });
  }
});
