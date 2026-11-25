import { describe, expect, it } from 'vitest';
import { createEngine, type EngineDeps } from '../src/engine.js';

/** A model of one dimension pair: the hidden state of a position is [id, 1], so a text's vector depends on its ids and nothing else. */
function deps(over: Partial<EngineDeps> = {}): EngineDeps & { runs: { batch: number; seqLen: number }[]; encoded: string[] } {
  const runs: { batch: number; seqLen: number }[] = [];
  const encoded: string[] = [];
  return {
    runs,
    encoded,
    dims: 2,
    maxTokens: 30,
    encode: (text) => {
      encoded.push(text);
      return [0, ...Array.from(text, (c) => c.charCodeAt(0) % 7), 2];
    },
    run: ({ ids, batch, seqLen }) => {
      runs.push({ batch, seqLen });
      return Promise.resolve({ data: Float32Array.from(Array.from(ids, (id) => [Number(id) + 1, 1]).flat()), dims: 2 });
    },
    ...over,
  };
}
const norm = (v: Float32Array): number => Math.hypot(...v);

describe('the engine', () => {
  it('reads each text with its prefix and answers one vector of norm 1 for each, in the order given', async () => {
    const d = deps();
    const r = await createEngine(d).embed('passage', ['ab', 'abc', 'a']);
    expect(d.encoded).toEqual(['passage: ab', 'passage: abc', 'passage: a'].map((t) => t));
    expect(r.ok && r.vectors.length).toBe(3);
    if (r.ok) for (const v of r.vectors) expect(norm(v)).toBeCloseTo(1, 5);
    const q = await createEngine(deps()).embed('query', ['ab']);
    expect(q.ok && q.vectors.length).toBe(1);
  });

  it('runs the model for one text at a time, so a text gives the same vector whatever it is embedded with', async () => {
    const d = deps();
    await createEngine(d).embed('passage', ['ab', 'abcd']);
    expect(d.runs.map((r) => r.batch)).toEqual([1, 1]);
    const alone = await createEngine(deps()).embed('passage', ['ab']);
    const together = await createEngine(deps()).embed('passage', ['ab', 'abcd']);
    expect(alone.ok && together.ok && Array.from(alone.vectors[0] as Float32Array)).toEqual(together.ok ? Array.from(together.vectors[0] as Float32Array) : []);
  });

  it('gives no vectors for no texts, and refuses nothing', async () => {
    expect(await createEngine(deps()).embed('passage', [])).toEqual({ ok: true, vectors: [] });
  });

  it('refuses a text over the limit (the prefix and the special tokens count), never cuts it, and runs nothing for it', async () => {
    const d = deps();
    // 'passage: ' is 9 characters, so 20 more make 29 ids plus 2 special tokens: over 30.
    expect(await createEngine(d).embed('passage', ['ab', 'x'.repeat(20)])).toEqual({ ok: false, reason: 'too-long' });
    expect(d.runs).toEqual([]);
  });

  it('refuses a text too long to fit whatever its tokens are, without tokenizing it', async () => {
    const d = deps();
    expect(await createEngine(d).embed('query', ['x'.repeat(30 * 64)])).toEqual({ ok: false, reason: 'too-long' });
    expect(d.encoded).toEqual([]);
  });

  it('answers internal when the model fails or returns what cannot be a vector, and never throws', async () => {
    expect(await createEngine(deps({ run: () => Promise.reject(new Error('boom')) })).embed('passage', ['a'])).toEqual({ ok: false, reason: 'internal' });
    // 'passage: a' is 10 characters and two special tokens: 12 positions of 2 values, all NaN.
    expect(await createEngine(deps({ run: () => Promise.resolve({ data: new Float32Array(24).fill(Number.NaN), dims: 2 }) })).embed('passage', ['a'])).toEqual({ ok: false, reason: 'internal' });
    expect(await createEngine(deps({ run: () => Promise.resolve({ data: new Float32Array(3), dims: 2 }) })).embed('passage', ['a'])).toEqual({ ok: false, reason: 'internal' });
  });
});
