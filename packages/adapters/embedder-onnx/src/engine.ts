import type { EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import { embeddingsFromHidden } from './pooling.js';
import { prefixed, type TextKind } from './prefix.js';

/** No token of these vocabularies is longer than this many characters, so a text longer than the limit times this cannot fit and is refused without being tokenized (a 100,000 character text costs nothing). */
const MAX_CHARS_PER_TOKEN = 64;

/**
 * The first half of embedding, on the thread that holds the tokenizer: the prefix, then the ids of each text (with the special tokens the model expects). A text over `maxTokens`, the
 * prefix and the special tokens counted, is refused (`too-long`), never cut: the chunker keeps every chunk under the limit, so a refusal is a bug to see, not a page that is silently half embedded.
 */
export function prepare(
  kind: TextKind,
  texts: readonly string[],
  encode: (text: string) => readonly number[],
  maxTokens: number,
): { readonly ok: true; readonly rows: (readonly number[])[] } | { readonly ok: false; readonly reason: 'too-long' } {
  const rows: (readonly number[])[] = [];
  for (const text of texts) {
    const full = prefixed(kind, text);
    if (full.length > maxTokens * MAX_CHARS_PER_TOKEN) return { ok: false, reason: 'too-long' };
    const ids = encode(full);
    if (ids.length > maxTokens) return { ok: false, reason: 'too-long' };
    rows.push(ids);
  }
  return { ok: true, rows };
}

/** What the second half needs of the runtime: one run of the model. */
export interface RunnerDeps {
  run(input: { readonly ids: BigInt64Array; readonly mask: BigInt64Array; readonly batch: number; readonly seqLen: number }): Promise<{ readonly data: Float32Array; readonly dims: number }>;
}

/**
 * The second half, on the model's thread: the attention mask, mean pooling and L2 normalisation of each row of ids. One text to a run, never a padded batch: the weights are quantised with a scale
 * taken over the whole input, so a text's vector would depend on the texts run with it. Alone, the same text always gives the same vector, which is what lets a stored chunk be kept when its text
 * did not change. It never throws.
 */
export function createRunner(deps: RunnerDeps): { embedRows(rows: readonly (readonly number[])[]): Promise<EmbedResult> } {
  return {
    async embedRows(rows) {
      const vectors: Float32Array[] = [];
      try {
        for (const row of rows) {
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
