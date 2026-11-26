import { describe, expect, it } from 'vitest';
import type { JobContext } from '@tektum/grimoire-core/ports/job-queue';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { FakeEmbeddingStore } from '@tektum/grimoire-core/testing/fake-embedding-store';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import { createEmbedPage, EMBED_BATCH, embedBatchSize } from '../../src/jobs/embed-page.js';
import { createRateLimiter } from '../../src/jobs/rate-limit.js';

// M7-T13: the embed-page job, on the fakes. The marker is a word placed in the page text: it must never reach a log line, an event or an error message.
const MARKER = 'zebra-marker-7741';
const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const PAGE = '11111111-1111-4111-8111-111111111111';
const ctxOf = (over: Partial<JobContext> = {}): JobContext => ({ jobId: 'j1', attempt: 1, retryLimit: 3, signal: new AbortController().signal, ...over });
/** `count` paragraphs of `words` words each (one chunk of its own when a paragraph is as long as the target). */
const paragraphs = (count: number, words = 200, tag = 'p'): string => Array.from({ length: count }, (_, i) => Array.from({ length: words }, (_, k) => `${tag}${String(i)}w${String(k)}`).join(' ')).join('\n\n');

function setup(text: string, options: { perMinute?: number; embedder?: FakeEmbedder } = {}) {
  const clock = new FakeClock(1_000_000);
  const store = new FakeEmbeddingStore(() => clock.now());
  store.seedPage({ id: PAGE, collectionId: 'c', markdownHash: hash(1), editedAt: 0, text });
  const embedder = options.embedder ?? new FakeEmbedder({ maxTokens: 512 });
  const logger = new FakeLogger();
  const limiter = createRateLimiter({ perMinute: options.perMinute ?? 100_000, now: () => clock.now(), sleep: (ms) => { clock.advance(ms); return Promise.resolve(); } });
  const handler = createEmbedPage({ embedder, store, log: createEventLog(logger), clock, limiter });
  const model = modelKey(embedder.model);
  const payload = { tenantId: 'legacy', pageId: PAGE };
  return { clock, store, embedder, logger, handler, model, payload };
}
const logged = (logger: FakeLogger): string => JSON.stringify(logger.entries);

describe('the embed-page job', () => {
  it('embeds the chunks of the page in batches, stores them with the state ready under the model of the embedder, and says how many', async () => {
    const s = setup(paragraphs(20));
    await s.handler(s.payload, ctxOf());
    const stored = s.store.stored(PAGE, s.model);
    expect(stored.chunks).toHaveLength(20);
    expect(stored.state).toMatchObject({ status: 'ready', attempts: 0 });
    expect(s.embedder.calls.map((c) => c.texts.length)).toEqual([EMBED_BATCH, 20 - EMBED_BATCH]);
    expect(s.embedder.calls[0]?.texts[0]?.startsWith('passage: ')).toBe(true);
    expect(s.logger.entries.find((e) => e.event === 'semantic.embedded')?.fields).toMatchObject({ pageId: PAGE, chunks: 20, reused: 0 });
    expect(s.model).toBe('fake-e5-v1');
  });

  it('embeds only the chunks that changed, and keeps the others with their stored vector', async () => {
    const s = setup(paragraphs(10));
    await s.handler(s.payload, ctxOf());
    const before = s.store.stored(PAGE, s.model).chunks.map((c) => c.embedding);
    s.embedder.calls.length = 0;
    s.store.editPage(PAGE, hash(2), 0, paragraphs(10).replace('p4w0 ', 'changed '));
    await s.handler(s.payload, ctxOf());
    expect(s.embedder.calls).toHaveLength(1);
    expect(s.embedder.calls[0]?.texts).toHaveLength(1); // one chunk of ten
    const after = s.store.stored(PAGE, s.model).chunks;
    expect(after).toHaveLength(10);
    expect(after.filter((c, i) => c.embedding !== before[i]).length).toBe(1);
    expect(s.logger.entries.filter((e) => e.event === 'semantic.embedded').at(-1)?.fields).toMatchObject({ chunks: 10, reused: 9 });
  });

  it('gives a page with no text no chunk and the state ready, without calling the embedder', async () => {
    const s = setup('two words');
    await s.handler(s.payload, ctxOf());
    expect(s.embedder.calls).toEqual([]);
    expect(s.store.stored(PAGE, s.model)).toMatchObject({ chunks: [], state: { status: 'ready' } });
  });

  it('writes nothing when the page was edited while it was embedded: the result is stale and the next sweep redoes the page', async () => {
    const edits = new FakeEmbedder({ maxTokens: 512 });
    const s = setup(paragraphs(3), { embedder: edits });
    const original = edits.embedPassages.bind(edits);
    edits.embedPassages = async (texts, o) => { s.store.editPage(PAGE, hash(2), 0); return original(texts, o); };
    await s.handler(s.payload, ctxOf());
    expect(s.store.stored(PAGE, s.model)).toMatchObject({ chunks: [], state: undefined });
    expect(s.logger.entries.some((e) => e.event === 'semantic.embedded')).toBe(false);
  });

  it('records failed with the reason code and no text when the embedder does not answer, fails the run so that pg-boss retries it, and logs the reason', async () => {
    const s = setup(`${MARKER} ${paragraphs(2)}`);
    s.embedder.failNext('timeout');
    const error = await s.handler(s.payload, ctxOf({ attempt: 2 })).then(() => undefined, (e: unknown) => e as Error);
    expect(error?.message).toBe('embed-failed:timeout');
    expect(s.store.stored(PAGE, s.model).state).toMatchObject({ status: 'failed', attempts: 1, error: 'timeout' });
    expect(s.logger.entries.find((e) => e.event === 'semantic.failed')?.fields).toEqual({ pageId: PAGE, reason: 'timeout', attempt: 2 });
    expect(logged(s.logger) + (error?.message ?? '')).not.toContain(MARKER);
  });

  it('fails without recording a failure when the embedder is not ready or the run was aborted: that is not the page\'s doing', async () => {
    const s = setup(paragraphs(2));
    s.embedder.setStatus('loading');
    await expect(s.handler(s.payload, ctxOf())).rejects.toThrow('embedder-unavailable');
    s.embedder.setStatus('ready');
    const stop = new AbortController();
    const abortingEmbedder = s.embedder;
    const original = abortingEmbedder.embedPassages.bind(abortingEmbedder);
    abortingEmbedder.embedPassages = (texts, o) => { stop.abort(); return original(texts, o); };
    await expect(s.handler(s.payload, ctxOf({ signal: stop.signal }))).rejects.toThrow(/aborted/);
    expect(s.store.stored(PAGE, s.model).state).toBeUndefined();
  });

  it('stops at the next batch when its signal aborts, keeping the batch it had finished and not marking the page ready', async () => {
    const s = setup(paragraphs(40));
    const stop = new AbortController();
    const original = s.embedder.embedPassages.bind(s.embedder);
    s.embedder.embedPassages = (texts, o) => { const r = original(texts, o); stop.abort(); return r; };
    await expect(s.handler(s.payload, ctxOf({ signal: stop.signal }))).rejects.toThrow('aborted');
    expect(s.embedder.calls).toHaveLength(1); // the second batch was not asked for
    expect(s.store.stored(PAGE, s.model).chunks).toHaveLength(EMBED_BATCH); // the first batch was saved as it was made
    expect(s.store.stored(PAGE, s.model).state).toBeUndefined();
  });

  it('holds the rate cap: with 60 chunks a minute and 200 chunks to embed, no more than 61 are embedded in the first minute', async () => {
    const s = setup(paragraphs(200), { perMinute: 60 });
    const started = s.clock.now();
    const asked: { at: number; chunks: number }[] = [];
    const original = s.embedder.embedPassages.bind(s.embedder);
    s.embedder.embedPassages = (texts, o) => { asked.push({ at: s.clock.now() - started, chunks: texts.length }); return original(texts, o); };
    await s.handler(s.payload, ctxOf());
    const firstMinute = asked.filter((a) => a.at <= 60_000).reduce((sum, a) => sum + a.chunks, 0);
    expect(firstMinute).toBeLessThanOrEqual(61);
    expect(firstMinute).toBeGreaterThan(30);
    expect(asked.reduce((sum, a) => sum + a.chunks, 0)).toBe(200);
    expect(s.clock.now() - started).toBeGreaterThanOrEqual(190_000); // 200 chunks at 60 a minute take over three minutes
    expect(s.store.stored(PAGE, s.model).chunks).toHaveLength(200);
  });

  it('keys the chunks by the model as it is when the job runs, not when it was built: the version of the weights is known only after the model has loaded', async () => {
    const embedder = new FakeEmbedder({ maxTokens: 512 });
    let version = 'loading';
    Object.defineProperty(embedder, 'model', { get: () => ({ name: 'fake-e5', version, dims: 8, maxTokens: 512 }) });
    const s = setup(paragraphs(2), { embedder });
    version = 'int8@3fa9c0d1'; // the load finished after the job was built
    await s.handler(s.payload, ctxOf());
    expect(s.store.stored(PAGE, 'fake-e5-int8@3fa9c0d1').chunks).toHaveLength(2);
    expect(s.store.stored(PAGE, 'fake-e5-loading').chunks).toEqual([]);
  });

  it('cuts chunks to the embedder\'s own limit when it is lower than the default, so no chunk is refused as too long', async () => {
    const small = new FakeEmbedder({ maxTokens: 30 });
    const s = setup(paragraphs(1, 200), { embedder: small }); // one 200-word paragraph, 30 tokens to a chunk
    await s.handler(s.payload, ctxOf());
    const chunks = s.store.stored(PAGE, s.model).chunks;
    expect(chunks.length).toBeGreaterThan(5);
    expect(Math.max(...chunks.map((c) => c.tokenCount))).toBeLessThanOrEqual(30);
    expect(s.store.stored(PAGE, s.model).state).toMatchObject({ status: 'ready' });
  });

  it('stores the offsets in code points, which the store reads a passage by, also after emoji', async () => {
    const text = `🙂🙂 ${paragraphs(1, 150, 'a')}\n\n🙂 ${paragraphs(1, 150, 'b')}`;
    const s = setup(text);
    await s.handler(s.payload, ctxOf());
    const points = Array.from(text);
    const chunks = s.store.stored(PAGE, s.model).chunks;
    expect(chunks).toHaveLength(2);
    for (const c of chunks) expect(points.slice(c.charStart, c.charEnd).join('')).toMatch(/^(🙂🙂 a0w0|🙂 b0w0) /);
    expect(chunks[1]?.charStart).not.toBe(text.indexOf('🙂 b')); // the UTF-16 index of the second chunk is two units further than its code point
  });

  it('keeps the chunks a cut-off run embedded: the next run embeds only the rest, and the page is ready when it ends', async () => {
    const s = setup(paragraphs(40)); // three batches: 16, 16, 8
    const stop = new AbortController();
    const original = s.embedder.embedPassages.bind(s.embedder);
    let calls = 0;
    s.embedder.embedPassages = async (texts, o) => { const r = await original(texts, o); calls += 1; if (calls === 2) stop.abort(); return r; };
    await expect(s.handler(s.payload, ctxOf({ signal: stop.signal }))).rejects.toThrow('aborted');
    expect(s.store.stored(PAGE, s.model).chunks).toHaveLength(32); // the two batches that finished are stored
    expect(s.store.stored(PAGE, s.model).state).toBeUndefined(); // but the page is not ready
    s.embedder.calls.length = 0;
    s.embedder.embedPassages = original;
    await s.handler(s.payload, ctxOf());
    expect(s.embedder.calls.flatMap((c) => c.texts)).toHaveLength(8); // only what was left
    expect(s.store.stored(PAGE, s.model)).toMatchObject({ state: { status: 'ready' } });
    expect(s.store.stored(PAGE, s.model).chunks).toHaveLength(40);
  });

  it('writes nothing more when the page changes between two batches of one run', async () => {
    const s = setup(paragraphs(40));
    const original = s.embedder.embedPassages.bind(s.embedder);
    let calls = 0;
    s.embedder.embedPassages = async (texts, o) => { calls += 1; if (calls === 2) s.store.editPage(PAGE, hash(2), 0); return original(texts, o); };
    await s.handler(s.payload, ctxOf());
    expect(s.store.stored(PAGE, s.model).chunks).toHaveLength(16); // the first batch was saved before the page changed; the second found it stale
    expect(s.store.stored(PAGE, s.model).state).toBeUndefined();
  });

  it('sizes a batch so that the wait for its share of the rate cap is a few minutes, never more than the job lives: 4 minutes of the rate, between 1 and 16 chunks', () => {
    expect([1, 2, 3, 4, 5, 600, 100_000].map(embedBatchSize)).toEqual([4, 8, 12, 16, 16, 16, 16]);
    expect(embedBatchSize(0.1)).toBe(1);
    expect(EMBED_BATCH).toBe(16);
  });

  it('records no failure when the embedder was shut down while the batch ran: a healthy page is not marked failed', async () => {
    const s = setup(paragraphs(3));
    const original = s.embedder.embedPassages.bind(s.embedder);
    s.embedder.embedPassages = async (texts, o) => { await original(texts, o); await s.embedder.close(); return { ok: false, reason: 'internal' }; };
    await expect(s.handler(s.payload, ctxOf())).rejects.toThrow('interrupted');
    expect(s.store.stored(PAGE, s.model).state).toBeUndefined();
    expect(s.logger.entries.some((e) => e.event === 'semantic.failed')).toBe(false);
    const stop = new AbortController();
    const s2 = setup(paragraphs(3));
    const original2 = s2.embedder.embedPassages.bind(s2.embedder);
    s2.embedder.embedPassages = async (texts, o) => { await original2(texts, o); stop.abort(); return { ok: false, reason: 'internal' }; };
    await expect(s2.handler(s2.payload, ctxOf({ signal: stop.signal }))).rejects.toThrow('interrupted');
    expect(s2.store.stored(PAGE, s2.model).state).toBeUndefined();
  });

  it('goes from failed back to ready when the embedder recovers: the retry writes the chunks and starts the attempts again', async () => {
    const s = setup(paragraphs(3));
    s.embedder.failNext('internal');
    await expect(s.handler(s.payload, ctxOf())).rejects.toThrow('embed-failed:internal');
    expect(s.store.stored(PAGE, s.model)).toMatchObject({ chunks: [], state: { status: 'failed', attempts: 1 } });
    await s.handler(s.payload, ctxOf({ attempt: 2 }));
    expect(s.store.stored(PAGE, s.model)).toMatchObject({ state: { status: 'ready', attempts: 0, error: null } });
    expect(s.store.stored(PAGE, s.model).chunks).toHaveLength(3);
  });

  it('does nothing for a page that is gone, in the trash, or of another tenant, and drops a payload of the wrong shape with a warning', async () => {
    const s = setup(paragraphs(2));
    s.store.trashPage(PAGE);
    await s.handler(s.payload, ctxOf());
    await s.handler({ tenantId: 'someone-else', pageId: PAGE }, ctxOf());
    await s.handler({ tenantId: 'legacy', pageId: '99999999-9999-4999-8999-999999999999' }, ctxOf());
    expect(s.embedder.calls).toEqual([]);
    for (const bad of [null, {}, { pageId: PAGE }, { tenantId: 'legacy', pageId: 'not-a-uuid' }, { tenantId: 'legacy', pageId: PAGE, text: MARKER }, 'x']) await s.handler(bad, ctxOf());
    expect(s.logger.entries.filter((e) => e.event === 'jobs.payload_invalid')).toHaveLength(6);
    expect(logged(s.logger)).not.toContain(MARKER);
  });

  it('never puts the text of a page or a vector in a log line', async () => {
    const s = setup(`${MARKER} ${paragraphs(3)}`);
    await s.handler(s.payload, ctxOf());
    const text = logged(s.logger);
    expect(text).not.toContain(MARKER);
    const vector = (s.store.stored(PAGE, s.model).chunks[0]?.embedding ?? new Float32Array()).values().next().value as number;
    expect(text).not.toContain(String(vector));
  });

  it('gives the event loop a turn at every count while it cuts a long page into chunks: the tokenizer is on the model thread, and a page of 20,000 words took 600 ms of counting in one piece on the main thread', async () => {
    const embedder = new FakeEmbedder({ maxTokens: 512 });
    const count = embedder.countTokens.bind(embedder);
    embedder.countTokens = (text) => new Promise((resolve) => setImmediate(() => resolve(count(text)))); // a round trip to another thread: the answer comes in a later turn
    const s = setup(paragraphs(200), { embedder }); // 200 paragraphs, 200 chunks
    let turns = 0;
    let running = true;
    const turn = (): void => {
      if (!running) return;
      turns += 1;
      setImmediate(turn);
    };
    setImmediate(turn);
    await s.handler(s.payload, ctxOf()); // the fakes answer at once, so every turn counted here was given by the job itself
    running = false;
    expect(s.store.stored(PAGE, s.model).chunks).toHaveLength(200);
    expect(turns).toBeGreaterThanOrEqual(100);
  });
});
