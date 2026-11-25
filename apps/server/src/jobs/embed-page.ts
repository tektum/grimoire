import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Embedder } from '@tektum/grimoire-core/ports/embedder';
import type { ChunkRow, EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import { chunkText } from '@tektum/grimoire-core/semantic/chunk';
import type { EventLog } from '../events.js';
import type { RateLimiter } from './rate-limit.js';
import { isEmbedPagePayload, type EmbedPagePayload } from './types.js';

export type { EmbedPagePayload } from './types.js';

/** Chunks embedded in one call of the embedder. */
export const EMBED_BATCH = 16;

/** What the `model` column holds: the name and the version of the weights, so a new build of the same model is a model change. */
export const semanticModelId = (embedder: Embedder): string => `${embedder.model.name}@${embedder.model.version}`;

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

export interface EmbedPageDeps {
  readonly embedder: Embedder;
  readonly store: EmbeddingStore;
  readonly log: EventLog;
  readonly clock: Clock;
  readonly limiter: RateLimiter;
}

/**
 * The `embed-page` job (contracts 15.4): read the page, cut its text into chunks, embed the chunks the store does not already hold (in batches, under the rate cap, never on
 * the main thread: the embedder owns its thread), and replace the page's chunks in one write that rechecks the page's hash (a page edited meanwhile is `stale`: nothing is
 * written, and the next sweep redoes it). A failure of the embedder is recorded (a reason code, never text) and fails the run, so that pg-boss retries it. Nothing here logs
 * the page's text, a query or a vector.
 */
export function createEmbedPage(deps: EmbedPageDeps): JobHandler<unknown> {
  const { embedder, store, log, clock, limiter } = deps;
  const model = semanticModelId(embedder);
  return async (payload, ctx) => {
    if (!isEmbedPagePayload(payload)) { log.warn('jobs.payload_invalid', { name: 'embed-page', jobId: ctx.jobId }); return; }
    const { tenantId, pageId }: EmbedPagePayload = payload;
    const began = clock.now();
    const page = await store.pageText(tenantId, pageId);
    if (page === undefined) return; // gone, in the trash, or without Markdown
    if (embedder.status() !== 'ready') throw new Error('embedder-unavailable'); // not the page's doing: no failure is recorded
    const chunks = chunkText(page.text, (text) => embedder.countTokens(text), { model });
    const existing = await store.existingHashes(tenantId, pageId, model);
    const changed = chunks.filter((c) => !sameBytes(existing.get(c.chunkIndex), c.contentHash));
    const vectors = new Map<number, Float32Array>();
    for (let i = 0; i < changed.length; i += EMBED_BATCH) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const batch = changed.slice(i, i + EMBED_BATCH);
      await limiter.acquire(batch.length, ctx.signal);
      const result = await embedder.embedPassages(batch.map((c) => c.text), { signal: ctx.signal });
      if (!result.ok) {
        if (result.reason === 'aborted' || result.reason === 'unavailable') throw new Error(result.reason);
        await store.markFailed(tenantId, pageId, page.markdownHash, model, result.reason);
        log.warn('semantic.failed', { pageId, reason: result.reason, attempt: ctx.attempt });
        throw new Error(`embed-failed:${result.reason}`);
      }
      batch.forEach((c, k) => { vectors.set(c.chunkIndex, result.vectors[k] as Float32Array); });
    }
    const rows: ChunkRow[] = chunks.map((c) => {
      const embedding = vectors.get(c.chunkIndex);
      return { chunkIndex: c.chunkIndex, contentHash: c.contentHash, charStart: c.charStart, charEnd: c.charEnd, tokenCount: c.tokenCount, ...(embedding === undefined ? {} : { embedding }) };
    });
    if (await store.replacePage(tenantId, pageId, page.markdownHash, model, rows) === 'stale') return;
    log.info('semantic.embedded', { pageId, chunks: chunks.length, reused: chunks.length - changed.length, ms: clock.now() - began });
  };
}
