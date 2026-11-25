import type { EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import type { TextKind } from './prefix.js';

/** The model's side of the embedder: the thing that runs it, apart from the rules about when and how it is called (those are `embedder.ts`). */
export interface Backend {
  /** Loads the model from these files. Rejects when it cannot. Resolves once, then `embed` may be called. */
  start(files: { readonly weights: string; readonly tokenizer: string }): Promise<void>;
  /** One batch. Never rejects: a failure of the model is `internal`. */
  embed(kind: TextKind, texts: readonly string[]): Promise<EmbedResult>;
  /** Called once if the model stops after it was started (its thread died); the embedder then reports `unavailable` and loads again. */
  onStopped(listener: () => void): void;
  /** Stops it. Idempotent. */
  close(): Promise<void>;
}

/** The messages between the embedder's thread and the model's thread. */
export type ToWorker = { readonly id: number; readonly kind: TextKind; readonly texts: readonly string[] };
export type FromWorker =
  | { readonly type: 'ready' }
  | { readonly type: 'load-failed' }
  | { readonly type: 'result'; readonly id: number; readonly result: { readonly ok: true; readonly buffers: ArrayBuffer[]; readonly dims: number } | { readonly ok: false; readonly reason: 'too-long' | 'internal' } };

export interface WorkerData {
  readonly weights: string;
  readonly tokenizer: string;
  readonly threads: number;
  readonly dims: number;
  readonly maxTokens: number;
}
