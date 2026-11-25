import { describe, expect, it } from 'vitest';
import { FakeAttachmentRepo } from '@tektum/grimoire-core/testing/fake-attachment-repo';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeTenantRepo } from '@tektum/grimoire-core/testing/fake-tenant-repo';
import { runUploadCleanup } from '../../src/jobs/upload-cleanup.js';

const NOW = 1_000_000;

function world() {
  const repo = new FakeAttachmentRepo();
  const files = new FakeFileStorage();
  const row = (id: string, tenantId: string, over: object = {}) => repo.seed({ id, pageId: 'p', uploaderId: 'u', fileName: 'f', contentType: 'image/png', size: 1, key: `tenants/${tenantId}/attachments/${id}`, tenantId, status: 'pending', expiresAt: NOW - 1000, createdAt: 0, readyAt: null, ...over });
  return { repo, files, row, deps: { tenants: new FakeTenantRepo(['T-a', 'T-b']), attachments: repo, files, now: () => NOW } };
}

describe('runUploadCleanup', () => {
  it('removes the expired pending uploads of every tenant with their objects, and keeps ready and live ones', async () => {
    const w = world();
    const rows = [w.row('a1', 'T-a'), w.row('b1', 'T-b'), w.row('a2', 'T-a', { expiresAt: NOW + 5000 }), w.row('a3', 'T-a', { status: 'ready', expiresAt: null, readyAt: 1 })];
    for (const r of rows) await w.files.put(r.key, new Uint8Array([1]), { size: 1, contentType: 'image/png' });
    expect(await runUploadCleanup(w.deps, new AbortController().signal)).toBe(2);
    expect(w.repo.all().map((r) => r.id).sort()).toEqual(['a2', 'a3']);
    expect(await w.files.head(rows[0]?.key as string).then(() => true, () => false)).toBe(false);
    expect(await w.files.head(rows[2]?.key as string).then(() => true, () => false)).toBe(true);
  });

  it('takes more than one batch of a tenant, and a second run finds nothing', async () => {
    const w = world();
    for (let i = 0; i < 5; i += 1) w.row(`a${String(i)}`, 'T-a');
    expect(await runUploadCleanup({ ...w.deps, batchSize: 2 }, new AbortController().signal)).toBe(5);
    expect(await runUploadCleanup(w.deps, new AbortController().signal)).toBe(0);
  });

  it('does not touch a row of another tenant when it asks for one tenant', async () => {
    const w = world();
    w.row('b1', 'T-b');
    expect(await runUploadCleanup({ ...w.deps, tenants: new FakeTenantRepo(['T-a']) }, new AbortController().signal)).toBe(0);
    expect(w.repo.all()).toHaveLength(1);
  });

  it('keeps going when a row of a batch is not removed because it completed meanwhile', async () => {
    const w = world();
    for (let i = 0; i < 5; i += 1) w.row(`a${String(i)}`, 'T-a');
    const first = w.repo.removeIfPending.bind(w.repo);
    const racing = Object.assign(Object.create(w.repo) as typeof w.repo, { removeIfPending: (tenantId: string, id: string) => (id === 'a0' ? Promise.resolve(false) : first(tenantId, id)) });
    expect(await runUploadCleanup({ ...w.deps, attachments: racing, batchSize: 2 }, new AbortController().signal)).toBe(4);
  });

  it('stops between batches when the signal aborts', async () => {
    const w = world();
    for (let i = 0; i < 4; i += 1) w.row(`a${String(i)}`, 'T-a');
    const stop = new AbortController();
    const deps = { ...w.deps, batchSize: 2, files: { ...w.files, delete: (key: string) => { stop.abort(); return w.files.delete(key); } } as unknown as typeof w.files };
    expect(await runUploadCleanup(deps, stop.signal)).toBe(2);
  });
});
