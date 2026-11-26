import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Embedder } from '@tektum/grimoire-core/ports/embedder';
import type { ChunkRow, EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import { chunkTextYielding } from '@tektum/grimoire-core/semantic/chunk';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import type { EventLog } from '../events.js';
import type { RateLimiter } from './rate-limit.js';
import { isEmbedPagePayload, type EmbedPagePayload } from './types.js';

export type { EmbedPagePayload } from './types.js';

/** Chunks embedded in one call of the embedder, at the most. */
export const EMBED_BATCH = 16;

/** Minutes of the rate cap that one batch may have to wait for: well under the 10 minutes a run lives, so a batch always gets its share before the run is cut off. */
const BATCH_WAIT_MINUTES = 4;

/**
 * The size of a batch at a rate of `perMinute` chunks a minute: at most `EMBED_BATCH`, and at a low rate fewer, so that the wait for a batch's share of the cap is about 4 minutes and
 * not more than the job lives (a batch of 16 at 1 chunk a minute would wait 16 minutes, and be cut off before it started). Every batch is saved as it is made (`saveChunks`), so a page
 * that needs more than one run keeps what each run did.
 */
export const embedBatchSize = (perMinute: number): number => Math.max(1, Math.min(EMBED_BATCH, Math.floor(perMinute * BATCH_WAIT_MINUTES)));

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

export interface EmbedPageDeps {
  readonly embedder: Embedder;
  readonly store: EmbeddingStore;
  readonly log: EventLog;
  readonly clock: Clock;
  readonly limiter: RateLimiter;
  /** Chunks to a batch (`embedBatchSize` of the rate cap). Default `EMBED_BATCH`. */
  readonly batchSize?: number;
}

/**
 * The `embed-page` job (contracts 15.4): read the page, cut its text into chunks, embed the chunks the store does not already hold (in batches, under the rate cap, never on
 * the main thread: the embedder owns its thread), and replace the page's chunks in one write that rechecks the page's hash (a page edited meanwhile is `stale`: nothing is
 * written, and the next sweep redoes it). A failure of the embedder is recorded (a reason code, never text) and fails the run, so that pg-boss retries it. Nothing here logs
 * the page's text, a query or a vector.
 */
export function createEmbedPage(deps: EmbedPageDeps): JobHandler<unknown> {
  const { embedder, store, log, clock, limiter } = deps;
  const size = deps.batchSize ?? EMBED_BATCH;
  return async (payload, ctx) => {
    if (!isEmbedPagePayload(payload)) { log.warn('jobs.payload_invalid', { name: 'embed-page', jobId: ctx.jobId }); return; }
    const { tenantId, pageId }: EmbedPagePayload = payload;
    const began = clock.now();
    const page = await store.pageText(tenantId, pageId);
    if (page === undefined) return; // gone, in the trash, or without Markdown
    if (embedder.status() !== 'ready') throw new Error('embedder-unavailable'); // not the page's doing: no failure is recorded
    // The key of the model as it is now: the version of the weights is known only once the model has loaded, and new weights are a model change (every page is embedded again).
    const model = modelKey(embedder.model);
    // Counting the tokens of a long page is main-thread work (600 ms in one piece for 20,000 words on a hosted runner, on the loop that serves requests): the cut gives the loop a turn between its steps.
    const chunks = await chunkTextYielding(page.text, (text) => embedder.countTokens(text), { model, maxTokens: Math.min(400, embedder.model.maxTokens) }, () => nextTurn()); // under the embedder's own limit, which the model's special tokens and prefix already come off
    const existing = await store.existingHashes(tenantId, pageId, model);
    const changed = chunks.filter((c) => !sameBytes(existing.get(c.chunkIndex), c.contentHash));
    const vectors = new Map<number, Float32Array>();
    for (let i = 0; i < changed.length; i += size) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const batch = changed.slice(i, i + size);
      await limiter.acquire(batch.length, ctx.signal);
      const result = await embedder.embedPassages(batch.map((c) => c.text), { signal: ctx.signal });
      if (!result.ok) {
        if (result.reason === 'aborted' || result.reason === 'unavailable') throw new Error(result.reason);
        if (ctx.signal.aborted || embedder.status() !== 'ready') throw new Error('interrupted'); // a shutdown ended the batch: not the page's doing, so no failure is recorded
        await store.markFailed(tenantId, pageId, page.markdownHash, model, result.reason);
        log.warn('semantic.failed', { pageId, reason: result.reason, attempt: ctx.attempt });
        throw new Error(`embed-failed:${result.reason}`);
      }
      batch.forEach((c, k) => { vectors.set(c.chunkIndex, result.vectors[k] as Float32Array); });
      if (i + size < changed.length) {
        // Not the last batch: save it now, so that a run that is cut off (the rate cap makes a long page slow) keeps its work and the next run starts where it stopped.
        const saved = batch.map((c) => ({ chunkIndex: c.chunkIndex, contentHash: c.contentHash, charStart: c.charStart, charEnd: c.charEnd, tokenCount: c.tokenCount, embedding: vectors.get(c.chunkIndex) as Float32Array }));
        if (await store.saveChunks(tenantId, pageId, page.markdownHash, model, saved) === 'stale') return;
        for (const c of batch) vectors.delete(c.chunkIndex); // stored: the final write keeps the stored vector
      }
    }
    const rows: ChunkRow[] = chunks.map((c) => {
      const embedding = vectors.get(c.chunkIndex);
      return { chunkIndex: c.chunkIndex, contentHash: c.contentHash, charStart: c.charStart, charEnd: c.charEnd, tokenCount: c.tokenCount, ...(embedding === undefined ? {} : { embedding }) };
    });
    if (await store.replacePage(tenantId, pageId, page.markdownHash, model, rows) === 'stale') return;
    log.info('semantic.embedded', { pageId, chunks: chunks.length, reused: chunks.length - changed.length, ms: clock.now() - began });
  };
}
