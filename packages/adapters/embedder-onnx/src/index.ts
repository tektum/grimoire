import type { SemanticConfig } from '@tektum/grimoire-core/ports/config';
import type { EmbedResult, Embedder } from '@tektum/grimoire-core/ports/embedder';

export { embeddingsFromHidden, l2Normalise, meanPool } from './pooling.js';
export { prefixed } from './prefix.js';

/** The two models the setting names: the length of their vectors, and the most tokens a text may have (the model's limit, prefix included). */
const MODELS = { 'multilingual-e5-base': { dims: 768 }, 'multilingual-e5-small': { dims: 384 } } as const;
const MAX_TOKENS = 512;

const UNAVAILABLE: EmbedResult = { ok: false, reason: 'unavailable' };

/**
 * The embedder of the semantic search (contracts section 15). This is its shape before the model is wired in (M7-T12): it reports `unavailable`, answers every embedding call
 * with `unavailable` (the search then runs on full text alone, R9.26) and never throws. `countTokens` is an estimate of three characters a token until the tokenizer is loaded.
 */
export function createOnnxEmbedder(config: SemanticConfig): Embedder {
  return {
    model: { name: config.model, version: 'int8', dims: MODELS[config.model].dims, maxTokens: MAX_TOKENS },
    status: () => 'unavailable',
    countTokens: (text) => Math.ceil(text.length / 3),
    embedPassages: () => Promise.resolve(UNAVAILABLE),
    embedQuery: () => Promise.resolve(UNAVAILABLE),
    stats: () => ({ threads: config.threads, queued: 0, chunksPerMinute: 0 }),
    close: () => Promise.resolve(),
  };
}
