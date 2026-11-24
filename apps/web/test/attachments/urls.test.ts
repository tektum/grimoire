import { describe, expect, it, vi } from 'vitest';
import { createUrlBatcher, MAX_BATCH, type SignedUrl } from '../../src/editor/attachments/urls';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const link = (n: number, expiresAt = 10_000_000): SignedUrl => ({ url: `https://files.test/${n}?sig=${expiresAt}`, expiresAt });

function fakeStore(options: { missing?: Set<string>; expiresAt?: number } = {}) {
  const calls: string[][] = [];
  const fetchUrls = vi.fn(async (ids: string[]) => {
    calls.push([...ids]);
    return new Map(ids.filter((i) => !options.missing?.has(i)).map((i, k) => [i, link(Number(i.slice(-12)) + k * 0, options.expiresAt)] as const));
  });
  return { calls, fetchUrls };
}

describe('the signed-URL batcher', () => {
  it('asks once for ids wanted in the same turn, and answers each', async () => {
    const store = fakeStore();
    const batcher = createUrlBatcher(store.fetchUrls, () => 0);
    const [a, b, c] = await Promise.all([batcher.url(id(1)), batcher.url(id(2)), batcher.url(id(3))]);
    expect(store.calls).toEqual([[id(1), id(2), id(3)]]);
    expect([a.url, b.url, c.url]).toEqual(['https://files.test/1?sig=10000000', 'https://files.test/2?sig=10000000', 'https://files.test/3?sig=10000000']);
  });

  it('asks for the same id once while its answer is awaited, and keeps the answer until it is about to expire', async () => {
    const store = fakeStore({ expiresAt: 1_000_000 });
    let now = 0;
    const batcher = createUrlBatcher(store.fetchUrls, () => now);
    const [x, y] = await Promise.all([batcher.url(id(1)), batcher.url(id(1))]);
    expect(x).toBe(y);
    await batcher.url(id(1));
    expect(store.calls).toHaveLength(1);
    now = 1_000_000 - 29_000; // inside the margin: a url that is about to expire is not handed out
    await batcher.url(id(1));
    expect(store.calls).toHaveLength(2);
  });

  it('hands out a fresh link that is already inside its margin, but does not keep it', async () => {
    const store = fakeStore({ expiresAt: 10_000 });
    const batcher = createUrlBatcher(store.fetchUrls, () => 0);
    expect((await batcher.url(id(1))).expiresAt).toBe(10_000); // 10 s left: inside the 30 s margin
    await batcher.url(id(1));
    expect(store.calls).toHaveLength(2);
  });

  it(`splits more than ${MAX_BATCH} ids into requests of at most ${MAX_BATCH}`, async () => {
    const store = fakeStore();
    const batcher = createUrlBatcher(store.fetchUrls, () => 0);
    await Promise.all(Array.from({ length: 120 }, (_, i) => batcher.url(id(i + 1))));
    expect(store.calls.map((c) => c.length)).toEqual([50, 50, 20]);
  });

  it('refresh asks again for one id, even when its answer has not expired, and concurrent refreshes share one request', async () => {
    const store = fakeStore();
    const batcher = createUrlBatcher(store.fetchUrls, () => 0);
    await batcher.url(id(1));
    await Promise.all([batcher.refresh(id(1)), batcher.refresh(id(1))]);
    expect(store.calls).toEqual([[id(1)], [id(1)]]);
  });

  it('rejects an id the server did not answer for (no access, deleted), and the next ask tries again', async () => {
    const store = fakeStore({ missing: new Set([id(2)]) });
    const batcher = createUrlBatcher(store.fetchUrls, () => 0);
    const [ok, missing] = await Promise.allSettled([batcher.url(id(1)), batcher.url(id(2))]);
    expect(ok.status).toBe('fulfilled');
    expect(missing.status).toBe('rejected');
    await expect(batcher.url(id(2))).rejects.toThrow();
    expect(store.calls).toEqual([[id(1), id(2)], [id(2)]]);
  });

  it('rejects every id of a request that failed, and forgets the failure', async () => {
    let fail = true;
    const batcher = createUrlBatcher(async (ids) => {
      if (fail) throw new Error('network');
      return new Map(ids.map((i) => [i, link(1)] as const));
    }, () => 0);
    await expect(Promise.all([batcher.url(id(1)), batcher.url(id(2))])).rejects.toThrow('network');
    fail = false;
    await expect(batcher.url(id(1))).resolves.toMatchObject({ url: expect.stringContaining('files.test') as string });
  });
});
