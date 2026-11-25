import { describe, expect, it } from 'vitest';
import { embeddingsFromHidden, l2Normalise, meanPool } from '../src/pooling.js';
import { prefixed } from '../src/prefix.js';

const norm = (v: Float32Array): number => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

describe('meanPool', () => {
  it('averages the token vectors of a text, counting only the tokens its attention mask keeps', () => {
    // One text of 4 positions and 2 dimensions; the last position is padding and holds a value that must not count.
    const hidden = Float32Array.from([1, 2, 3, 4, 5, 6, 100, 100]);
    const [v] = meanPool(hidden, [1, 1, 1, 0], 1, 4, 2);
    expect([...(v as Float32Array)]).toEqual([3, 4]);
  });

  it('pools each text of a batch with its own mask, and takes the int64 mask the runtime gives', () => {
    // Two texts, 3 positions, 2 dimensions: the first uses all three positions, the second one.
    const hidden = Float32Array.from([1, 1, 2, 2, 3, 3, 10, 20, 99, 99, 99, 99]);
    const pooled = meanPool(hidden, BigInt64Array.from([1n, 1n, 1n, 1n, 0n, 0n]), 2, 3, 2);
    expect(pooled.map((v) => [...v])).toEqual([
      [2, 2],
      [10, 20],
    ]);
  });

  it('gives a zero vector for a text whose mask keeps nothing, never a division by zero', () => {
    const [v] = meanPool(Float32Array.from([5, 5, 5, 5]), [0, 0], 1, 2, 2);
    expect([...(v as Float32Array)]).toEqual([0, 0]);
  });

  it('refuses sizes that do not fit the tensors, so a wrong shape cannot be read as another', () => {
    expect(() => meanPool(new Float32Array(7), [1, 1, 1, 1], 1, 4, 2)).toThrow(/hidden/);
    expect(() => meanPool(new Float32Array(8), [1, 1, 1], 1, 4, 2)).toThrow(/mask/);
  });
});

describe('l2Normalise', () => {
  it('scales a vector to norm 1 in place, within 1e-5', () => {
    const v = Float32Array.from([3, 4]);
    expect(l2Normalise(v)).toBe(true);
    expect(norm(v)).toBeCloseTo(1, 5);
    expect([v[0], v[1]]).toEqual([Math.fround(0.6), Math.fround(0.8)]);
  });

  it('refuses a vector it cannot normalise (zero, NaN, infinite) and leaves it as it was', () => {
    for (const bad of [
      [0, 0],
      [1, Number.NaN],
      [Number.POSITIVE_INFINITY, 1],
    ]) {
      const v = Float32Array.from(bad);
      expect(l2Normalise(v)).toBe(false);
      expect([...v].map(String)).toEqual(bad.map(String));
    }
  });
});

describe('embeddingsFromHidden', () => {
  it('pools and normalises each text: every vector has norm 1', () => {
    const hidden = Float32Array.from([1, 0, 3, 0, 0, 2, 0, 4]);
    const r = embeddingsFromHidden(hidden, [1, 1, 1, 1], 2, 2, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vectors.map((v) => [...v].map((x) => Math.round(x * 1e4) / 1e4))).toEqual([
      [1, 0],
      [0, 1],
    ]);
    for (const v of r.vectors) expect(norm(v)).toBeCloseTo(1, 5);
  });

  it('answers internal when the model returned something that cannot be a vector (NaN, or a text of only padding)', () => {
    expect(embeddingsFromHidden(Float32Array.from([Number.NaN, 1]), [1], 1, 1, 2)).toEqual({ ok: false, reason: 'internal' });
    expect(embeddingsFromHidden(Float32Array.from([1, 1]), [0], 1, 1, 2)).toEqual({ ok: false, reason: 'internal' });
  });
});

describe('prefixed', () => {
  it('adds the prefix each kind of text needs in front, once: the e5 models read "query: " and "passage: "', () => {
    expect(prefixed('query', 'how do I log in')).toBe('query: how do I log in');
    expect(prefixed('passage', 'Logging in needs a token.')).toBe('passage: Logging in needs a token.');
  });

  it('does not strip or change the text itself, whatever it holds', () => {
    expect(prefixed('passage', '')).toBe('passage: ');
    expect(prefixed('query', '  spaced \n text ')).toBe('query:   spaced \n text ');
  });
});
