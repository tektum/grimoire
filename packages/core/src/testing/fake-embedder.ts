import { createHash } from 'node:crypto';
import type { EmbedResult, Embedder, EmbedderModel } from '../ports/embedder.js';

export interface FakeEmbedderOptions {
  readonly name?: string;
  readonly version?: string;
  readonly dims?: number;
  readonly maxTokens?: number;
  readonly threads?: number;
}

type Failure = Extract<EmbedResult, { ok: false }>['reason'];

/**
 * An embedder with no model: a text becomes a vector by hashing its words into `dims` buckets, so texts that share words are near each other, the same text always gives the
 * same vector, and a prefix (`passage: ` or `query: `) changes it as it does in the real models. Tokens are the words of the text. `failNext` scripts one failure, `calls` records
 * what was asked, and `setStatus` plays a model that is loading or gone.
 */
export class FakeEmbedder implements Embedder {
  readonly model: EmbedderModel;
  /** The texts of each call, with the prefix the adapter would add. */
  readonly calls: { readonly kind: 'passages' | 'query'; readonly texts: readonly string[] }[] = [];
  private current: 'loading' | 'ready' | 'unavailable' = 'ready';
  private failure: Failure | undefined;
  private closed = false;
  private readonly threads: number;

  constructor(options: FakeEmbedderOptions = {}) {
    this.model = { name: options.name ?? 'fake-e5', version: options.version ?? 'v1', dims: options.dims ?? 8, maxTokens: options.maxTokens ?? 16 };
    this.threads = options.threads ?? 1;
  }

  setStatus(status: 'loading' | 'ready' | 'unavailable'): void {
    this.current = status;
  }

  /** The next embedding call fails with this reason, once. */
  failNext(reason: Failure): void {
    this.failure = reason;
  }

  status(): 'loading' | 'ready' | 'unavailable' {
    return this.closed ? 'unavailable' : this.current;
  }

  countTokens(text: string): Promise<number> {
    return Promise.resolve(this.count(text));
  }

  embedPassages(texts: readonly string[], o: { readonly signal?: AbortSignal } = {}): Promise<EmbedResult> {
    return this.embed('passages', 'passage: ', texts, o.signal);
  }

  embedQuery(text: string, o: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<EmbedResult> {
    return this.embed('query', 'query: ', [text], o.signal);
  }

  stats(): { threads: number; queued: number; chunksPerMinute: number } {
    return { threads: this.threads, queued: 0, chunksPerMinute: 0 };
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private embed(kind: 'passages' | 'query', prefix: string, texts: readonly string[], signal: AbortSignal | undefined): Promise<EmbedResult> {
    this.calls.push({ kind, texts: texts.map((t) => prefix + t) });
    if (this.status() !== 'ready') return Promise.resolve({ ok: false, reason: 'unavailable' });
    if (signal?.aborted === true) return Promise.resolve({ ok: false, reason: 'aborted' });
    if (this.failure !== undefined) {
      const reason = this.failure;
      this.failure = undefined;
      return Promise.resolve({ ok: false, reason });
    }
    if (texts.some((t) => this.count(t) > this.model.maxTokens)) return Promise.resolve({ ok: false, reason: 'too-long' });
    return Promise.resolve({ ok: true, vectors: texts.map((t) => vectorOf(prefix + t, this.model.dims)) });
  }

  private count(text: string): number {
    return words(text).length;
  }
}

const words = (text: string): string[] => text.toLowerCase().split(/\s+/).filter((w) => w !== '');

/** Each word adds or subtracts one in a bucket chosen by its hash; the result is scaled to length 1. A text with no words points along the first axis. */
export function vectorOf(text: string, dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (const word of words(text)) {
    const h = createHash('sha256').update(word).digest();
    const bucket = h.readUInt32BE(0) % dims;
    v[bucket] = (v[bucket] as number) + ((h[4] as number) % 2 === 0 ? 1 : -1);
  }
  let norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) {
    v[0] = 1;
    norm = 1;
  }
  return v.map((x) => x / norm);
}
