import { describe, expect, it } from 'vitest';
import type { JobContext } from '@tektum/grimoire-core/ports/job-queue';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { FakeEmbeddingStore } from '@tektum/grimoire-core/testing/fake-embedding-store';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import { createEventLog } from '../../../src/events.js';
import { createEmbedSweep, SWEEP_PAGES } from '../../../src/jobs/embed-sweep.js';
import type { EmbedPagePayload } from '../../../src/jobs/types.js';

// M7-T13: the embed sweep, on the fakes. A run sends the next one first (amendment 16a), then hands the pages that need embedding to `embed-page`.
const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const ctxOf = (signal = new AbortController().signal): JobContext => ({ jobId: 'j1', attempt: 1, retryLimit: 3, signal });

function setup(o: { readonly onPage?: () => void } = {}) {
  const clock = new FakeClock(1_000_000);
  const store = new FakeEmbeddingStore(() => clock.now());
  const embedder = new FakeEmbedder();
  const logger = new FakeLogger();
  const calls: (readonly ['sweep', number] | readonly ['page', EmbedPagePayload])[] = [];
  const queue = {
    enqueueEmbedSweep: (delaySeconds: number) => { calls.push(['sweep', delaySeconds]); return Promise.resolve('s'); },
    enqueueEmbedPage: (payload: EmbedPagePayload) => { calls.push(['page', payload]); o.onPage?.(); return Promise.resolve('p'); },
  };
  const handler = createEmbedSweep({ tenants: { ids: () => Promise.resolve(['a', 'b']) }, store, embedder, queue, log: createEventLog(logger), sweepSeconds: 15, debounceSeconds: 30 });
  const seed = (tenant: string, n: number, editedAt = 0): string => {
    const id = `${tenant}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    store.seedPage({ id, collectionId: 'c', markdownHash: hash(1), tenantId: tenant, editedAt });
    return id;
  };
  return { clock, store, embedder, logger, calls, handler, seed, model: modelKey(embedder.model) };
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

  describe('after a model change', () => {
    const started = (logger: FakeLogger) => logger.entries.filter((e) => e.event === 'semantic.reembed_started').map((e) => e.fields);
    /** `count` pages of tenant a, embedded under another model. */
    const embeddedUnderOld = async (s: ReturnType<typeof setup>, count: number): Promise<string[]> => {
      const ids = Array.from({ length: count }, (_, n) => s.seed('a', n, n));
      for (const id of ids) await s.store.replacePage('a', id, hash(1), 'old-model-v1', []);
      return ids;
    };

    it('says once that every page is queued to be embedded again, and hands them on 50 at a time as the earlier ones are replaced page by page', async () => {
      const s = setup();
      const ids = await embeddedUnderOld(s, 120);
      const handed = async (): Promise<string[]> => {
        s.calls.length = 0;
        await s.handler(null, ctxOf());
        return s.calls.flatMap((c) => (c[0] === 'page' ? [c[1].pageId] : []));
      };
      const first = await handed();
      expect(first).toEqual(ids.slice(0, SWEEP_PAGES));
      expect(started(s.logger)).toEqual([{ model: s.model, pages: 120 }]);
      for (const id of first) await s.store.replacePage('a', id, hash(1), s.model, []); // embed-page, with the new model
      const second = await handed();
      expect(second).toEqual(ids.slice(SWEEP_PAGES, 2 * SWEEP_PAGES));
      for (const id of second) await s.store.replacePage('a', id, hash(1), s.model, []);
      expect(await handed()).toEqual(ids.slice(2 * SWEEP_PAGES));
      expect(started(s.logger)).toHaveLength(1); // not again while the rollout goes on
      expect(await s.store.counts(s.model)).toMatchObject({ pagesReady: 100, pagesPending: 20, pagesOtherModel: 20 });
    });

    it('says nothing for pages that were never embedded (a first start of semantic search is not a model change), and nothing while the embedder is still loading', async () => {
      const fresh = setup();
      fresh.seed('a', 1);
      await fresh.handler(null, ctxOf());
      expect(started(fresh.logger)).toEqual([]);
      const loading = setup();
      await embeddedUnderOld(loading, 2);
      loading.embedder.setStatus('loading');
      await loading.handler(null, ctxOf());
      expect(started(loading.logger)).toEqual([]);
      loading.embedder.setStatus('ready');
      await loading.handler(null, ctxOf());
      expect(started(loading.logger)).toEqual([{ model: loading.model, pages: 2 }]); // the first run that could know the model's key
    });
  });
});
