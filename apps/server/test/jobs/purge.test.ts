import { describe, expect, it } from 'vitest';
import { FakeTenantRepo } from '@tektum/grimoire-core/testing/fake-tenant-repo';
import { FakeTrashRepo } from '@tektum/grimoire-core/testing/fake-trash-repo';
import { TRASH_RETENTION_MS, runPurge } from '../../src/jobs/purge.js';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const COLLECTION = '00000000-0000-4000-8000-0000000000c1';

function world() {
  const trash = new FakeTrashRepo();
  const deleted: string[][] = [];
  const deps = { tenants: new FakeTenantRepo(['T-a', 'T-b']), trash, deleteFiles: (keys: readonly string[]) => { deleted.push([...keys]); return Promise.resolve(); }, now: () => NOW };
  const old = (tenantId: string, days: number, attachments: string[] = []) => trash.seedDeleted({ collectionId: COLLECTION, tenantId, deletedAt: NOW - days * DAY, attachments });
  return { trash, deleted, deps, old };
}

describe('runPurge', () => {
  it('removes batches deleted more than 30 days ago, in every tenant, with their objects, and leaves younger ones', async () => {
    const w = world();
    const a31 = w.old('T-a', 31, ['tenants/T-a/attachments/1']);
    const a29 = w.old('T-a', 29, ['tenants/T-a/attachments/2']);
    const b45 = w.old('T-b', 45);
    expect(TRASH_RETENTION_MS).toBe(30 * DAY);
    expect(await runPurge(w.deps, new AbortController().signal)).toEqual({ pages: 2, objects: 1 });
    expect([a31, a29, b45].map((id) => w.trash.state(id))).toEqual(['gone', 'deleted', 'gone']);
    expect(w.deleted).toEqual([['tenants/T-a/attachments/1']]);
  });

  it('changes nothing on a second run', async () => {
    const w = world();
    w.old('T-a', 31, ['k']);
    await runPurge(w.deps, new AbortController().signal);
    expect(await runPurge(w.deps, new AbortController().signal)).toEqual({ pages: 0, objects: 0 });
    expect(w.deleted).toHaveLength(1);
  });

  it('treats the 30-day boundary by the clock it is given', async () => {
    const w = world();
    const id = w.old('T-a', 29);
    await runPurge(w.deps, new AbortController().signal);
    expect(w.trash.state(id)).toBe('deleted');
    await runPurge({ ...w.deps, now: () => NOW + 2 * DAY }, new AbortController().signal);
    expect(w.trash.state(id)).toBe('gone');
  });

  it('purges every batch of a tenant, more than one round of the batch size', async () => {
    const w = world();
    const ids = Array.from({ length: 7 }, () => w.old('T-a', 40));
    expect(await runPurge({ ...w.deps, batchSize: 3 }, new AbortController().signal)).toEqual({ pages: 7, objects: 0 });
    expect(ids.map((id) => w.trash.state(id))).toEqual(Array(7).fill('gone'));
  });

  it('keeps going with the other tenants when one fails, then fails the job so that it is retried', async () => {
    const w = world();
    const a = w.old('T-a', 40, ['a-key']);
    const b = w.old('T-b', 40, ['b-key']);
    const deps = { ...w.deps, deleteFiles: (keys: readonly string[]) => (keys[0] === 'a-key' ? Promise.reject(new Error('store down')) : Promise.resolve()) };
    await expect(runPurge(deps, new AbortController().signal)).rejects.toThrow('store down');
    expect([w.trash.state(a), w.trash.state(b)]).toEqual(['deleted', 'gone']);
    expect(await runPurge(w.deps, new AbortController().signal)).toEqual({ pages: 1, objects: 1 });
  });

  it('stops at the next batch when the signal aborts, and reports what it did', async () => {
    const w = world();
    const first = w.old('T-a', 40);
    const second = w.old('T-a', 39);
    const stop = new AbortController();
    const deps = { ...w.deps, batchSize: 1, deleteFiles: () => { stop.abort(); return Promise.resolve(); } };
    w.trash.seedDeleted({ collectionId: COLLECTION, tenantId: 'T-a', deletedAt: NOW - 50 * DAY, attachments: ['k'] });
    expect((await runPurge(deps, stop.signal)).pages).toBe(1);
    expect([w.trash.state(first), w.trash.state(second)]).toEqual(['deleted', 'deleted']);
  });
});
