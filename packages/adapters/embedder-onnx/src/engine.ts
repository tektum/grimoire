import type { EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import { embeddingsFromHidden } from './pooling.js';
import { prefixed, type TextKind } from './prefix.js';

/** What the engine needs of the runtime: the ids of a text (with the special tokens the model expects), and one run of the model. */
export interface EngineDeps {
  encode(text: string): readonly number[];
  run(input: { readonly ids: BigInt64Array; readonly mask: BigInt64Array; readonly batch: number; readonly seqLen: number }): Promise<{ readonly data: Float32Array; readonly dims: number }>;
  readonly dims: number;
  /** The model's limit, the special tokens and the prefix included. */
  readonly maxTokens: number;
}

/** No token of these vocabularies is longer than this many characters, so a text longer than the limit times this cannot fit and is refused without being tokenized (a 100,000 character text costs nothing). */
const MAX_CHARS_PER_TOKEN = 64;

/**
 * Text to vectors with the model's own steps: the prefix, the tokenizer, the attention mask, mean pooling and L2 normalisation. A text over the limit is refused
 * (`too-long`), never cut: the chunker keeps every chunk under it, so a refusal is a bug to see, not a page that is silently half embedded. It never throws.
 */
export function createEngine(deps: EngineDeps): { embed(kind: TextKind, texts: readonly string[]): Promise<EmbedResult> } {
  return {
    async embed(kind, texts) {
      const encoded: (readonly number[])[] = [];
      for (const text of texts) {
        const full = prefixed(kind, text);
        if (full.length > deps.maxTokens * MAX_CHARS_PER_TOKEN) return { ok: false, reason: 'too-long' };
        const ids = deps.encode(full);
        if (ids.length > deps.maxTokens) return { ok: false, reason: 'too-long' };
        encoded.push(ids);
      }
      // One text to a run, never a padded batch: the weights are quantised with a scale taken over the whole input, so a text's vector would depend on the texts run with it. Alone, the same text always
      // gives the same vector, which is what lets a stored chunk be kept when its text did not change.
      const vectors: Float32Array[] = [];
      try {
        for (const row of encoded) {
          const ids = BigInt64Array.from(row, (id) => BigInt(id));
          const mask = new BigInt64Array(row.length).fill(1n);
          const out = await deps.run({ ids, mask, batch: 1, seqLen: row.length });
          const pooled = embeddingsFromHidden(out.data, mask, 1, row.length, out.dims);
          if (!pooled.ok) return pooled;
          vectors.push(...pooled.vectors);
        }
      } catch {
        return { ok: false, reason: 'internal' };
      }
      return { ok: true, vectors };
    },
  };
}
