import { describe, expect, it } from 'vitest';
import { FakeImportRepo } from '@tektum/grimoire-core/testing/fake-import-repo';
import { FakeTenantRepo } from '@tektum/grimoire-core/testing/fake-tenant-repo';
import type { ImportStatus } from '@tektum/grimoire-core/ports/import-repo';
import { reconcileEndedImports } from '../../src/jobs/import-reconcile.js';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const live = new AbortController().signal;

function world() {
  const imports = new FakeImportRepo();
  const deleted: string[] = [];
  const row = (id: string, tenantId: string, status: ImportStatus, endedDaysAgo: number) =>
    imports.seed({ id, tenantId, status, s3Key: `tenants/${tenantId}/imports/${id}/source.zip`, finishedAt: NOW - endedDaysAgo * DAY });
  return {
    imports,
    deleted,
    row,
    deps: {
      tenants: new FakeTenantRepo(['T-a', 'T-b']),
      imports,
      deleteFiles: (keys: readonly string[]) => {
        deleted.push(...keys);
        return Promise.resolve();
      },
      abortUpload: () => Promise.resolve(),
      zipPresent: (key: string) => Promise.resolve(!deleted.includes(key)),
      now: () => NOW,
    },
  };
}

describe('reconcileEndedImports', () => {
  it('deletes the zip of every import that ended more than a day ago (a cleanup that was never enqueued or never ran), and leaves a fresh one to its own cleanup', async () => {
    const w = world();
    for (const [id, status] of [
      ['d', 'done'],
      ['f', 'failed'],
      ['c', 'cancelled'],
    ] as const)
      w.row(id, 'T-a', status, 2);
    w.row('fresh', 'T-a', 'done', 0.5);
    w.row('b1', 'T-b', 'failed', 3);
    const out = await reconcileEndedImports(w.deps, live);
    expect(out.zips).toBe(4);
    expect(w.deleted.sort()).toEqual(['tenants/T-a/imports/c/source.zip', 'tenants/T-a/imports/d/source.zip', 'tenants/T-a/imports/f/source.zip', 'tenants/T-b/imports/b1/source.zip']);
  });

  it('trashes the pages of a cancelled or failed import that were not trashed, once, and none for a done import', async () => {
    const w = world();
    w.row('f', 'T-a', 'failed', 2);
    w.row('d', 'T-a', 'done', 2);
    const spy: string[] = [];
    const trash = w.imports.trashImported.bind(w.imports);
    w.imports.trashImported = (t, i) => {
      spy.push(i);
      return trash(t, i);
    };
    await reconcileEndedImports(w.deps, live);
    expect(spy).toEqual(['f']);
  });

  it('looks back a fortnight only, and does nothing for an import with no zip key', async () => {
    const w = world();
    w.row('old', 'T-a', 'failed', 15);
    w.imports.seed({ id: 'nokey', tenantId: 'T-a', status: 'failed', finishedAt: NOW - 2 * DAY });
    const out = await reconcileEndedImports(w.deps, live);
    expect(out.zips).toBe(0);
    expect(w.deleted).toEqual([]);
  });

  it('goes through more than one batch, and a second run deletes the same keys again without harm', async () => {
    const w = world();
    for (let i = 0; i < 5; i += 1) w.row(`i${String(i)}`, 'T-a', 'done', 2);
    expect((await reconcileEndedImports({ ...w.deps, batch: 2 }, live)).zips).toBe(5);
    expect((await reconcileEndedImports({ ...w.deps, batch: 2 }, live)).zips).toBe(5);
  });
});
