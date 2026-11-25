import type { EmbedResult } from '@tektum/grimoire-core/ports/embedder';

/**
 * The mean of the token vectors of each text, over the tokens its attention mask keeps (padding does not count). `hidden` is the model's `last_hidden_state`, row-major
 * `[batch, seqLen, dims]`; `mask` is `[batch, seqLen]` of 0 and 1 (the runtime gives int64, so a `BigInt64Array` is read as it is). A text whose mask keeps nothing gives the zero
 * vector, which `l2Normalise` then refuses.
 */
export function meanPool(hidden: Float32Array, mask: ArrayLike<number | bigint>, batch: number, seqLen: number, dims: number): Float32Array[] {
  if (hidden.length !== batch * seqLen * dims) throw new Error(`hidden has ${String(hidden.length)} values, ${String(batch)} x ${String(seqLen)} x ${String(dims)} were expected`);
  if (mask.length !== batch * seqLen) throw new Error(`mask has ${String(mask.length)} values, ${String(batch)} x ${String(seqLen)} were expected`);
  const pooled: Float32Array[] = [];
  for (let b = 0; b < batch; b += 1) {
    const sum = new Float64Array(dims);
    let kept = 0;
    for (let t = 0; t < seqLen; t += 1) {
      if (Number(mask[b * seqLen + t]) === 0) continue;
      kept += 1;
      const at = (b * seqLen + t) * dims;
      for (let d = 0; d < dims; d += 1) sum[d] = (sum[d] as number) + (hidden[at + d] as number);
    }
    const out = new Float32Array(dims);
    if (kept > 0) for (let d = 0; d < dims; d += 1) out[d] = (sum[d] as number) / kept;
    pooled.push(out);
  }
  return pooled;
}

/** Scales `v` to length 1 in place and says so; a vector that has no direction (all zero) or holds a NaN or an infinity is left as it was and refused. */
export function l2Normalise(v: Float32Array): boolean {
  let sum = 0;
  for (const x of v) sum += x * x;
  const length = Math.sqrt(sum);
  if (!Number.isFinite(length) || length === 0) return false;
  for (let i = 0; i < v.length; i += 1) v[i] = (v[i] as number) / length;
  return true;
}

/** The port's answer for a batch the model has run: pooled and normalised, or `internal` when a vector cannot be one (the port never throws and never returns a vector that is not of length 1). */
export function embeddingsFromHidden(hidden: Float32Array, mask: ArrayLike<number | bigint>, batch: number, seqLen: number, dims: number): EmbedResult {
  const vectors = meanPool(hidden, mask, batch, seqLen, dims);
  for (const v of vectors) if (!l2Normalise(v)) return { ok: false, reason: 'internal' };
  return { ok: true, vectors };
}
