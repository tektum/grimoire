import { randomUUID } from 'node:crypto';
import type { AttachmentRow } from '../../src/ports/attachment-repo.js';
import type { FileStorage } from '../../src/ports/file-storage.js';
import { FakeAttachmentRepo } from '../../src/testing/fake-attachment-repo.js';
import { FakeFileStorage } from '../../src/testing/fake-file-storage.js';
import type { AttachmentDeps } from '../../src/attachments/uploads.js';

export const NOW = 1_700_000_000_000;
export const LIMITS = { maxBytes: 1000, allowedTypes: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'text/html-not'], pendingMaxPerUser: 2 };
export const USER = randomUUID();
export const PAGE = randomUUID();

/** A repository, a store and the dependencies of the use cases, on a clock the test moves. */
export function setup(over: { sniff?: AttachmentDeps['sniff']; files?: FileStorage; pages?: (id: string) => boolean } = {}) {
  const clock = { at: NOW };
  const repo = new FakeAttachmentRepo(over.pages === undefined ? {} : { pages: over.pages });
  const files = new FakeFileStorage({ clock: { now: () => clock.at } });
  let n = 0;
  const deps: AttachmentDeps = {
    repo, files: over.files ?? files, now: () => clock.at, newId: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
    sniff: over.sniff ?? (() => Promise.resolve(undefined)),
  };
  return { repo, files, deps, clock };
}

export const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => {
  const id = over.id ?? randomUUID();
  return { id, pageId: PAGE, uploaderId: USER, fileName: 'a.png', contentType: 'image/png', size: 10, key: `attachments/${id}`, status: 'pending', expiresAt: NOW + 3_600_000, createdAt: NOW, readyAt: null, ...over };
};
