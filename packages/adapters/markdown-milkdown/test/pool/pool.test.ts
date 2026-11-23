import Piscina from 'piscina';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCorpus } from '../../src/testing/corpus.js';
import { generateMarkdown } from '../../src/testing/generate.js';
import { stateFromMarkdown } from '../../src/testing/states.js';
import { convertInProcess, createMarkdownConverter, seedInProcess } from '../../src/index.js';
import type { PooledMarkdownConverter } from '../../src/index.js';
import { ensureBuilt } from './support.js';

let converter: PooledMarkdownConverter;

beforeAll(() => {
  ensureBuilt();
  converter = createMarkdownConverter();
});
afterAll(async () => {
  await converter.close();
});

describe('options', () => {
  it('default to the contracts', () => {
    expect(converter.options).toMatchObject({ poolSize: 2, seedTimeoutMs: 10_000, timeoutMs: 10_000, heapMb: 512, maxDepth: 100, maxBlocks: 50_000 });
    expect(converter.options).toMatchObject({ maxStateBytes: 1_000_000, maxSeedMarkdownBytes: 131_072 });
  });
  it('refuse a timeout the timer cannot hold, and every limit that is not a positive integer (a NaN or a 0 cannot switch a check off)', async () => {
    expect(() => createMarkdownConverter({ timeoutMs: 4_294_967_296 })).toThrow(RangeError);
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      expect(() => createMarkdownConverter({ maxDepth: bad })).toThrow(RangeError);
      expect(() => createMarkdownConverter({ maxBlocks: bad })).toThrow(RangeError);
      expect(() => createMarkdownConverter({ maxStateBytes: bad })).toThrow(RangeError);
    }
    const defaulted = createMarkdownConverter({ maxDepth: undefined });
    try {
      expect(defaulted.options.maxDepth).toBe(100); // absent keeps the default
    } finally {
      await defaulted.close();
    }
  });
  it('a state over the size limit and a detached buffer are typed failures, and nothing is copied or queued for them', async () => {
    // One thread and room for exactly one queued call: if a refused input had been counted as pending, the two valid calls below could not both be accepted.
    const converter = createMarkdownConverter({ maxStateBytes: 256, poolSize: 1, queueLimit: 1 });
    try {
      expect(await converter.toMarkdown(new Uint8Array(257))).toMatchObject({ ok: false, reason: 'too-large' });
      const detached = new Uint8Array(8);
      structuredClone(detached.buffer, { transfer: [detached.buffer] });
      expect(await converter.toMarkdown(detached)).toMatchObject({ ok: false });
      expect(converter.stats().queued).toBe(0);
      const valid = await stateFromMarkdown('x\n');
      expect(valid.byteLength).toBeLessThanOrEqual(256);
      const calls = [converter.toMarkdown(valid), converter.toMarkdown(valid)];
      expect(converter.stats().queued).toBe(1);
      expect(await Promise.all(calls)).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    } finally {
      await converter.close();
    }
  });
  it('refuse a nonsense pool size at construction, not at the first call', () => {
    expect(() => createMarkdownConverter({ poolSize: 0 })).toThrow(RangeError);
    for (const queueLimit of [0, -1, 1.5, Number.NaN]) expect(() => createMarkdownConverter({ queueLimit })).toThrow(RangeError);
  });
});

describe('determinism: the pool answers byte for byte as the in-process converter', () => {
  const fixtures = [
    ['prose', generateMarkdown('prose', 10_000)],
    ['mixed', generateMarkdown('mixed', 10_000)],
    ['tables', generateMarkdown('tables', 5_000)],
  ] as const;
  it.each(fixtures)('three fixture states: %s', async (_name, markdown) => {
    const state = await stateFromMarkdown(markdown);
    expect(await converter.toMarkdown(state)).toEqual(await convertInProcess(state));
  });
  it('every case of the stability corpus, to Markdown and back', async () => {
    for (const { name, markdown } of loadCorpus()) {
      const seeded = await converter.seed(markdown, 'test-key');
      const direct = await seedInProcess(markdown);
      // A seed of user Markdown is written under a fresh client id, so the bytes differ; the outcome and the document do not.
      if (!seeded.ok || !direct.ok) {
        expect(seeded, name).toEqual(direct);
        continue;
      }
      expect(await convertInProcess(seeded.state), name).toEqual(await convertInProcess(direct.state));
      expect(await converter.toMarkdown(seeded.state), name).toEqual(await convertInProcess(seeded.state));
    }
  });
});

describe('typed results', () => {
  it('invalid bytes are invalid-state, and the next call on the same pool succeeds', async () => {
    expect(await converter.toMarkdown(new Uint8Array([255, 255, 255, 255, 255]))).toMatchObject({ ok: false, reason: 'invalid-state' });
    const state = await stateFromMarkdown('after the failure\n');
    expect(await converter.toMarkdown(state)).toMatchObject({ ok: true, markdown: 'after the failure\n' });
  });
  it('a value that is not bytes is invalid-state without reaching a worker', async () => {
    expect(await converter.toMarkdown('text' as unknown as Uint8Array)).toMatchObject({ ok: false, reason: 'invalid-state' });
  });
  it('seed failures of the converter pass through unchanged', async () => {
    const small = createMarkdownConverter({ maxSeedMarkdownBytes: 4 });
    try {
      expect(await small.seed('longer than four', 'test-key')).toMatchObject({ ok: false, reason: 'too-large' });
    } finally {
      await small.close();
    }
  });
});

describe('transfer', () => {
  it('moves a copy: the caller keeps its bytes, and the call hands piscina a transferList holding a buffer', async () => {
    const state = await stateFromMarkdown('# Transfer\n\nbody\n');
    const before = Array.from(state);
    const run = vi.spyOn(Piscina.prototype, 'run');
    const result = await converter.toMarkdown(state);
    const options = run.mock.calls[0]?.[1];
    run.mockRestore();
    expect(result.ok).toBe(true);
    expect(state.byteLength).toBe(before.length);
    expect(Array.from(state)).toEqual(before);
    const list: unknown = options?.transferList;
    expect(Array.isArray(list) && list.length === 1 && list[0] instanceof ArrayBuffer).toBe(true);
    // Not the caller's own buffer: that one was copied, not detached.
    expect(Array.isArray(list) && list[0] !== state.buffer).toBe(true);
  });
  it('a view into a larger buffer neither detaches that buffer nor leaks its neighbours', async () => {
    const state = await stateFromMarkdown('view into a larger buffer\n');
    const big = new Uint8Array(state.byteLength + 200).fill(7);
    big.set(state, 100);
    const view = big.subarray(100, 100 + state.byteLength);
    const snapshot = Array.from(big);
    expect(await converter.toMarkdown(view)).toMatchObject({ ok: true, markdown: 'view into a larger buffer\n' });
    expect(big.buffer.byteLength).toBe(big.byteLength);
    expect(Array.from(big)).toEqual(snapshot);
  });
  it('a Buffer (whose slice shares memory) is copied as well', async () => {
    const state = await stateFromMarkdown('buffer input\n');
    const buffer = Buffer.from(state);
    expect(await converter.toMarkdown(buffer)).toMatchObject({ ok: true, markdown: 'buffer input\n' });
    expect(buffer.byteLength).toBe(state.byteLength);
  });
  it('the seeded state arrives as a plain Uint8Array on its own buffer', async () => {
    const seeded = await converter.seed('# seeded\n', 'test-key');
    expect(seeded.ok).toBe(true);
    if (seeded.ok) {
      expect(seeded.state.byteOffset).toBe(0);
      expect(seeded.state.buffer.byteLength).toBe(seeded.state.byteLength);
    }
  });
});

describe('close', () => {
  it('resolves, leaves no thread, is idempotent, and later calls fail typed', async () => {
    const own = createMarkdownConverter();
    expect(own.stats().threads).toBe(2);
    await own.close();
    await own.close();
    expect(own.stats()).toEqual({ threads: 0, queued: 0 });
    expect(await own.toMarkdown(new Uint8Array(1))).toEqual({ ok: false, reason: 'internal', detail: 'closed', message: 'The converter is shutting down. Try again in a moment.' });
    expect(await own.seed('x', 'test-key')).toEqual({ ok: false, reason: 'internal', detail: 'closed', message: 'The converter is shutting down. Try again in a moment.' });
  });
});
