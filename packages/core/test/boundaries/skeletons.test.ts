import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './paths.js';
import * as idempotencyStore from '../../src/testing/fake-idempotency-store.js';
import * as collectionRepo from '../../src/testing/fake-collection-repo.js';
import * as auditLog from '../../src/testing/fake-audit-log.js';
import * as pageRepo from '../../src/testing/fake-page-repo.js';
import * as trashRepo from '../../src/testing/fake-trash-repo.js';
import * as revisionRepo from '../../src/testing/fake-revision-repo.js';
import * as adminRepo from '../../src/testing/fake-admin-repo.js';
import * as pageStateRepo from '../../src/testing/fake-page-state-repo.js';
import * as jobQueue from '../../src/testing/fake-job-queue.js';
import * as fileStorage from '../../src/testing/fake-file-storage.js';
import * as attachmentRepo from '../../src/testing/fake-attachment-repo.js';

const fakes: Record<string, Record<string, unknown>> = {
  'idempotency-store': idempotencyStore,
  'collection-repo': collectionRepo,
  'audit-log': auditLog,
  'page-repo': pageRepo,
  'trash-repo': trashRepo,
  'revision-repo': revisionRepo,
  'admin-repo': adminRepo,
  'page-state-repo': pageStateRepo,
  'job-queue': jobQueue,
  'file-storage': fileStorage,
  'attachment-repo': attachmentRepo,
};

/** The ports of the milestone 4 foundation: port file, fake file, the interface and the fake class each exports. */
const resources = [
  ['idempotency-store', 'IdempotencyStore', 'FakeIdempotencyStore'],
  ['collection-repo', 'CollectionRepo', 'FakeCollectionRepo'],
  ['audit-log', 'AuditLog', 'FakeAuditLog'],
  ['page-repo', 'PageRepo', 'FakePageRepo'],
  ['trash-repo', 'TrashRepo', 'FakeTrashRepo'],
  ['revision-repo', 'RevisionRepo', 'FakeRevisionRepo'],
  ['admin-repo', 'AdminRepo', 'FakeAdminRepo'],
  ['page-state-repo', 'PageStateRepo', 'FakePageStateRepo'],
  ['job-queue', 'JobQueue', 'FakeJobQueue'],
  ['file-storage', 'FileStorage', 'FakeFileStorage'],
  ['attachment-repo', 'AttachmentRepo', 'FakeAttachmentRepo'],
] as const;

const core = path.join(repoRoot, 'packages/core/src');

describe.each(resources)('%s', (file, port, fake) => {
  it('has a port that exports its interface, with no import at all', () => {
    const source = readFileSync(path.join(core, 'ports', `${file}.ts`), 'utf8');
    expect(source).toMatch(new RegExp(`export (interface|type) ${port}\\b`));
    expect(source).not.toMatch(/^\s*import\b/m);
  });

  it('has a fake that is a class implementing the port and can be constructed', () => {
    expect(existsSync(path.join(core, 'testing', `fake-${file}.ts`))).toBe(true);
    const exported = fakes[file]?.[fake];
    expect(typeof exported).toBe('function');
    const Fake = exported as new () => object;
    expect(new Fake()).toBeInstanceOf(Fake);
  });
});
