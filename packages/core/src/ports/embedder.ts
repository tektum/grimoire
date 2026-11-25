/** What an embedding call answers: the vectors, one for each text and in the order given, or the reason it could not. A call never throws. */
export type EmbedResult =
  | { readonly ok: true; readonly vectors: Float32Array[] }
  | { readonly ok: false; readonly reason: 'unavailable' | 'timeout' | 'too-long' | 'aborted' | 'internal' };

export interface EmbedderModel {
  /** The model's name, for example `multilingual-e5-base`. */
  readonly name: string;
  /** What tells one build of the weights from another: with the name it is the `model` column of `page_chunks`, so a change of either re-embeds the pages. */
  readonly version: string;
  /** The length of every vector. */
  readonly dims: number;
  /** The most tokens one text may have. */
  readonly maxTokens: number;
}

/**
 * Text to vectors, for the semantic search (R2.45, R9.26). The core knows no runtime library: the adapter owns the model, the tokenizer and the worker.
 * Every vector is L2-normalised, so the dot product of two is their cosine similarity. The adapter adds whatever a model needs in front of a text (the e5 models want
 * `passage: ` before a page's text and `query: ` before a search): callers pass the plain text, and `embedQuery` and `embedPassages` of the same text differ.
 * A text over `model.maxTokens` is either refused with `too-long` or cut to the limit, as the adapter documents; the chunker keeps every chunk under it, so a refusal is a bug to see.
 * A call that is aborted (`signal`) or runs out of `timeoutMs` ends with `aborted` or `timeout` and leaves nothing running that a later call waits for.
 */
export interface Embedder {
  readonly model: EmbedderModel;
  /** `loading` until the model is read, `ready` when it can embed, `unavailable` when it cannot (missing or altered files, a failed load that is retried, closed). */
  status(): 'loading' | 'ready' | 'unavailable';
  /** The tokens of `text`, with no prefix, as the model counts them. Synchronous: the chunker calls it for every paragraph. */
  countTokens(text: string): number;
  embedPassages(texts: readonly string[], o?: { readonly signal?: AbortSignal }): Promise<EmbedResult>;
  embedQuery(text: string, o?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<EmbedResult>;
  stats(): { readonly threads: number; readonly queued: number; readonly chunksPerMinute: number };
  /** Idempotent. Every call after it answers `unavailable`. */
  close(): Promise<void>;
}
