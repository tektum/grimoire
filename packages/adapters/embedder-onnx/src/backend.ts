import type { EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import type { TextKind } from './prefix.js';

/** The model's side of the embedder: the thing that runs it, apart from the rules about when and how it is called (those are `embedder.ts`). */
export interface Backend {
  /** Loads the model from these files. Rejects when it cannot. Resolves once, then `embed` may be called. */
  start(files: { readonly weights: string; readonly tokenizer: string }): Promise<void>;
  /** One batch. Never rejects: a failure of the model is `internal`. */
  embed(kind: TextKind, texts: readonly string[]): Promise<EmbedResult>;
  /** The tokens of a text as the model counts them, or undefined when the model's thread cannot say (it is gone, or the tokenizer threw). Never rejects. */
  count(text: string): Promise<number | undefined>;
  /** Called once if the model stops after it was started (its thread died); the embedder then reports `unavailable` and loads again. */
  onStopped(listener: () => void): void;
  /** Stops it. Idempotent. */
  close(): Promise<void>;
}

/**
 * The messages between the embedder's thread and the model's thread. The tokenizer is on the model's thread and nowhere else (its 160 MB of live objects on the server's heap made every full
 * GC stop the event loop for 150 ms and more on a loaded runner): texts go there, and the thread prefixes, tokenizes, checks the length and runs the model, or only counts. It answers a count
 * while a batch runs in the model (the run is awaited, the thread is free), so the chunker is not held up by an embedding.
 */
export type ToWorker =
  | { readonly type: 'embed'; readonly id: number; readonly kind: TextKind; readonly texts: readonly string[] }
  | { readonly type: 'count'; readonly id: number; readonly text: string };
export type FromWorker =
  | { readonly type: 'ready' }
  | { readonly type: 'load-failed' }
  | { readonly type: 'count'; readonly id: number; readonly tokens: number | null }
  | { readonly type: 'result'; readonly id: number; readonly result: { readonly ok: true; readonly buffers: ArrayBuffer[]; readonly dims: number } | { readonly ok: false; readonly reason: 'too-long' | 'internal' } };

export interface WorkerData {
  readonly weights: string;
  readonly tokenizer: string;
  readonly threads: number;
  readonly dims: number;
  /** The most tokens a text may have, the special tokens and the prefix included. */
  readonly maxTokens: number;
}
