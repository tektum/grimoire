import { describe, expect, it } from 'vitest';
import { cleanupExpiredAttachments } from '../../src/attachments/cleanup.js';
import { NOW, row, setup } from './support.js';

async function world() {
  const t = setup();
  const expired1 = t.repo.seed(row({ id: 'e1', expiresAt: NOW - 3000 }));
  const expired2 = t.repo.seed(row({ id: 'e2', expiresAt: NOW - 2000 }));
  const live = t.repo.seed(row({ id: 'l1', expiresAt: NOW + 1000 }));
  const ready = t.repo.seed(row({ id: 'r1', status: 'ready', expiresAt: null, readyAt: NOW - 9000 }));
  for (const r of [expired1, expired2, live, ready]) await t.files.put(r.key, new Uint8Array([1]), { size: 1, contentType: 'image/png' });
  return { ...t, expired1, expired2, live, ready, run: (batch = 100) => cleanupExpiredAttachments({ repo: t.repo, files: t.files, tenantId: 'legacy', now: () => NOW, batch }) };
}
const present = async (files: Awaited<ReturnType<typeof world>>['files'], key: string): Promise<boolean> => files.head(key).then(() => true, () => false);

describe('cleanupExpiredAttachments', () => {
  it('removes the objects and rows of expired pending uploads only, and says how many', async () => {
    const w = await world();
    expect(await w.run()).toBe(2);
    expect(w.repo.all().map((r) => r.id).sort()).toEqual(['l1', 'r1']);
    expect([await present(w.files, w.expired1.key), await present(w.files, w.expired2.key)]).toEqual([false, false]);
    expect([await present(w.files, w.live.key), await present(w.files, w.ready.key)]).toEqual([true, true]);
  });

  it('is safe to run again: the second run finds nothing', async () => {
    const w = await world();
    await w.run();
    expect(await w.run()).toBe(0);
  });

  it('takes at most one batch, the oldest first', async () => {
    const w = await world();
    expect(await w.run(1)).toBe(1);
    expect(w.repo.all().map((r) => r.id).sort()).toEqual(['e2', 'l1', 'r1']);
  });

  it('removes an object whose row is already gone, and does not count a row that completed in the meantime', async () => {
    const w = await world();
    const racing = { ...w.repo, expiredPending: w.repo.expiredPending.bind(w.repo), removeIfPending: (tenantId: string, id: string) => (id === 'e1' ? Promise.resolve(false) : w.repo.removeIfPending(tenantId, id)) } as unknown as typeof w.repo;
    expect(await cleanupExpiredAttachments({ repo: racing, files: w.files, tenantId: 'legacy', now: () => NOW, batch: 100 })).toBe(1);
  });

  it('stops on a store that is down and leaves the rows for the next run', async () => {
    const w = await world();
    const down = { ...w.files, delete: () => Promise.reject(new Error('down')) } as unknown as typeof w.files;
    await expect(cleanupExpiredAttachments({ repo: w.repo, files: down, tenantId: 'legacy', now: () => NOW, batch: 100 })).rejects.toThrow('down');
    expect(w.repo.all().filter((r) => r.id.startsWith('e'))).toHaveLength(2);
  });
});
