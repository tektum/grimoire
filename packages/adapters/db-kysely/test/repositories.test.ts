import { describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin.js';
import { createAttachments } from '../src/attachments.js';
import { createAudit } from '../src/audit.js';
import { createCollections } from '../src/collections.js';
import { createIdempotency } from '../src/idempotency.js';
import { createPages } from '../src/pages.js';
import { createPageState } from '../src/page-state.js';
import { createRevisions } from '../src/revisions.js';
import { createTrash } from '../src/trash.js';
import type { KyselyDatabase } from '../src/index.js';

// A repository is built from the typed handle only; nothing here may touch the database before a method is called.
const handle = new Proxy({}, { get: () => { throw new Error('the factory used the database'); } }) as KyselyDatabase;

describe.each([
  ['createIdempotency', createIdempotency],
  ['createCollections', createCollections],
  ['createAudit', createAudit],
  ['createPages', createPages],
  ['createTrash', createTrash],
  ['createRevisions', createRevisions],
  ['createAdmin', createAdmin],
  ['createPageState', createPageState],
  ['createAttachments', createAttachments],
] as const)('%s', (_name, create) => {
  it('returns a repository without using the database', () => {
    expect(create(handle)).toBeTypeOf('object');
  });
});
