import { describe, expect, it } from 'vitest';
import { createRunner, prepare } from '../src/engine.js';

const encode = (text: string): number[] => [0, ...Array.from(text, (c) => c.charCodeAt(0) % 7), 2];
const norm = (v: Float32Array): number => Math.hypot(...v);

/** A model of two dimensions: the hidden state of a position is [id + 1, 1], so a text's vector depends on its ids and nothing else. */
function model(over: Partial<Parameters<typeof createRunner>[0]> = {}) {
  const runs: { batch: number; seqLen: number }[] = [];
  const runner = createRunner({
    run: ({ ids, batch, seqLen }) => {
      runs.push({ batch, seqLen });
      return Promise.resolve({ data: Float32Array.from(Array.from(ids, (id) => [Number(id) + 1, 1]).flat()), dims: 2 });
    },
    ...over,
  });
  return { runs, runner };
}

describe('prepare: the texts as the model reads them', () => {
  it('puts the prefix of its kind in front of each text and gives the ids of each, in the order given', () => {
    const seen: string[] = [];
    const r = prepare('passage', ['ab', 'abc'], (t) => (seen.push(t), encode(t)), 100);
    expect(seen).toEqual(['passage: ab', 'passage: abc']);
    expect(r.ok && r.rows.map((row) => row.length)).toEqual([2 + 'passage: ab'.length, 2 + 'passage: abc'.length]);
    const q: string[] = [];
    prepare('query', ['x'], (t) => (q.push(t), encode(t)), 100);
    expect(q).toEqual(['query: x']);
  });

  it('has no rows for no texts, and refuses nothing', () => {
    expect(prepare('passage', [], encode, 30)).toEqual({ ok: true, rows: [] });
  });

  it('refuses a text over the limit (the prefix and the special tokens count), never cuts it, and tokenizes nothing after it', () => {
    const seen: string[] = [];
    // 'passage: ' is 9 characters, so 20 more make 29 ids plus 2 special tokens: over 30.
    expect(prepare('passage', ['ab', 'x'.repeat(20), 'cd'], (t) => (seen.push(t), encode(t)), 30)).toEqual({ ok: false, reason: 'too-long' });
    expect(seen).toHaveLength(2);
  });

  it('refuses a text too long to fit whatever its tokens are, without tokenizing it', () => {
    const seen: string[] = [];
    expect(prepare('query', ['x'.repeat(30 * 64)], (t) => (seen.push(t), encode(t)), 30)).toEqual({ ok: false, reason: 'too-long' });
    expect(seen).toEqual([]);
  });
});

describe('createRunner: the model run on rows of ids', () => {
  it('answers one vector of norm 1 for each row, in the order given', async () => {
    const { runner } = model();
    const r = await runner.embedRows([encode('ab'), encode('abc'), encode('a')]);
    expect(r.ok && r.vectors.length).toBe(3);
    if (r.ok) for (const v of r.vectors) expect(norm(v)).toBeCloseTo(1, 5);
  });

  it('runs the model for one text at a time, so a text gives the same vector whatever it is embedded with', async () => {
    const { runs, runner } = model();
    await runner.embedRows([encode('ab'), encode('abcd')]);
    expect(runs.map((r) => r.batch)).toEqual([1, 1]);
    const alone = await model().runner.embedRows([encode('ab')]);
    const together = await model().runner.embedRows([encode('ab'), encode('abcd')]);
    expect(alone.ok && together.ok && Array.from(alone.vectors[0] as Float32Array)).toEqual(together.ok ? Array.from(together.vectors[0] as Float32Array) : []);
  });

  it('gives no vectors for no rows', async () => {
    expect(await model().runner.embedRows([])).toEqual({ ok: true, vectors: [] });
  });

  it('answers internal when the model fails or returns what cannot be a vector, and never throws', async () => {
    expect(await model({ run: () => Promise.reject(new Error('boom')) }).runner.embedRows([encode('a')])).toEqual({ ok: false, reason: 'internal' });
    // 'a' is 3 ids: 3 positions of 2 values, all NaN.
    expect(await model({ run: () => Promise.resolve({ data: new Float32Array(6).fill(Number.NaN), dims: 2 }) }).runner.embedRows([encode('a')])).toEqual({ ok: false, reason: 'internal' });
    expect(await model({ run: () => Promise.resolve({ data: new Float32Array(3), dims: 2 }) }).runner.embedRows([encode('a')])).toEqual({ ok: false, reason: 'internal' });
  });
});
