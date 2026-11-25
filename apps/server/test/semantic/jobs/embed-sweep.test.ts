import { describe, expect, it } from 'vitest';
import type { JobContext } from '@tektum/grimoire-core/ports/job-queue';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { FakeEmbeddingStore } from '@tektum/grimoire-core/testing/fake-embedding-store';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import { createEmbedSweep, SWEEP_PAGES } from '../../../src/jobs/embed-sweep.js';
import type { EmbedPagePayload } from '../../../src/jobs/types.js';

// M7-T13: the embed sweep, on the fakes. A run sends the next one first (amendment 16a), then hands the pages that need embedding to `embed-page`.
const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const ctxOf = (signal = new AbortController().signal): JobContext => ({ jobId: 'j1', attempt: 1, retryLimit: 3, signal });

function setup(o: { readonly onPage?: () => void } = {}) {
  const clock = new FakeClock(1_000_000);
  const store = new FakeEmbeddingStore(() => clock.now());
  const embedder = new FakeEmbedder();
  const calls: (readonly ['sweep', number] | readonly ['page', EmbedPagePayload])[] = [];
  const queue = {
    enqueueEmbedSweep: (delaySeconds: number) => { calls.push(['sweep', delaySeconds]); return Promise.resolve('s'); },
    enqueueEmbedPage: (payload: EmbedPagePayload) => { calls.push(['page', payload]); o.onPage?.(); return Promise.resolve('p'); },
  };
  const handler = createEmbedSweep({ tenants: { ids: () => Promise.resolve(['a', 'b']) }, store, embedder, queue, sweepSeconds: 15, debounceSeconds: 30 });
  const seed = (tenant: string, n: number, editedAt = 0): string => {
    const id = `${tenant}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    store.seedPage({ id, collectionId: 'c', markdownHash: hash(1), tenantId: tenant, editedAt });
    return id;
  };
  return { clock, store, embedder, calls, handler, seed, model: modelKey(embedder.model) };
}

describe('the embed sweep', () => {
  it('hands every tenant\'s pages that changed and were left alone to embed-page, ids only, at most 50 a tenant and the oldest first', async () => {
    const s = setup();
    const a = Array.from({ length: SWEEP_PAGES + 10 }, (_, n) => s.seed('a', n, n));
    const b = [s.seed('b', 1)];
    s.seed('b', 2, s.clock.now() - 10_000); // saved 10 s ago: still being worked on
    const done = s.seed('b', 3);
    await s.store.replacePage('b', done, hash(1), s.model, []); // embedded already, under this model and this Markdown
    await s.handler(null, ctxOf());
    expect(s.calls[0]).toEqual(['sweep', 15]);
    expect(s.calls.slice(1)).toEqual([...a.slice(0, SWEEP_PAGES).map((id) => ['page', { tenantId: 'a', pageId: id }]), ...b.map((id) => ['page', { tenantId: 'b', pageId: id }])]);
    expect(SWEEP_PAGES).toBe(50);
  });

  it('sends its next run before its work, so a run that fails leaves the chain whole (the retry sends it again, and its key makes that one run)', async () => {
    const s = setup();
    s.store.pagesNeedingEmbedding = () => Promise.reject(new Error('database gone'));
    await expect(s.handler(null, ctxOf())).rejects.toThrow('database gone');
    expect(s.calls).toEqual([['sweep', 15]]);
  });

  it('with the model still loading, sends its next run and hands nothing on (the key of the model is not known yet)', async () => {
    const s = setup();
    s.seed('a', 1);
    s.embedder.setStatus('loading');
    await s.handler(null, ctxOf());
    expect(s.calls).toEqual([['sweep', 15]]);
  });

  it('stops between tenants when its signal aborts', async () => {
    const stop = new AbortController();
    const s = setup({ onPage: () => { stop.abort(); } });
    const a = [s.seed('a', 1), s.seed('a', 2)];
    s.seed('b', 1);
    await s.handler(null, ctxOf(stop.signal));
    expect(s.calls.slice(1)).toEqual(a.map((id) => ['page', { tenantId: 'a', pageId: id }]));
  });
});
