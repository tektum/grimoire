import assert from 'node:assert/strict';
import type { Embedder } from '../ports/embedder.js';

/**
 * What every Embedder does, run against the fake and against the real adapter. `make` builds a fresh embedder that is ready to embed (the real one waits for its model to
 * load); `longText` is a text over `model.maxTokens` tokens for the embedder it makes. Every case closes what it makes.
 */
export interface EmbedderHarness {
  make(): Promise<Embedder>;
  longText(model: Embedder['model']): string;
}

export interface EmbedderCase { readonly name: string; run(h: EmbedderHarness): Promise<void> }

export const embedderCaseNames = [
  'dimension-and-norm', 'same-text-same-vector', 'query-and-passage-differ', 'order-and-count', 'too-long', 'aborted', 'close-is-idempotent', 'never-throws', 'stats-and-tokens',
] as const;

async function using<T>(h: EmbedderHarness, work: (e: Embedder) => Promise<T>): Promise<T> {
  const e = await h.make();
  try {
    return await work(e);
  } finally {
    await e.close();
  }
}

const norm = (v: Float32Array): number => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
const same = (a: Float32Array, b: Float32Array): boolean => a.length === b.length && a.every((x, i) => Math.abs(x - (b[i] as number)) < 1e-6);

export const embedderConformance: readonly EmbedderCase[] = [
  {
    name: 'dimension-and-norm',
    async run(h) {
      await using(h, async (e) => {
        assert.equal(e.status(), 'ready');
        const r = await e.embedPassages(['the quarterly plan', 'a recipe for soup', 'x']);
        assert.ok(r.ok, 'embedding works');
        assert.equal(r.vectors.length, 3);
        for (const v of r.vectors) {
          assert.equal(v.length, e.model.dims);
          assert.ok(Math.abs(norm(v) - 1) < 1e-5, `norm ${String(norm(v))}`);
        }
      });
    },
  },
  {
    name: 'same-text-same-vector',
    async run(h) {
      await using(h, async (e) => {
        const [a, b] = [await e.embedPassages(['the quarterly plan']), await e.embedPassages(['the quarterly plan', 'another text'])];
        assert.ok(a.ok && b.ok);
        assert.ok(same(a.vectors[0] as Float32Array, b.vectors[0] as Float32Array), 'the same text gives the same vector whatever is embedded with it');
        assert.ok(!same(b.vectors[0] as Float32Array, b.vectors[1] as Float32Array), 'different texts give different vectors');
      });
    },
  },
  {
    name: 'query-and-passage-differ',
    async run(h) {
      await using(h, async (e) => {
        const [passage, query] = [await e.embedPassages(['the quarterly plan']), await e.embedQuery('the quarterly plan')];
        assert.ok(passage.ok && query.ok);
        assert.equal(query.vectors.length, 1);
        assert.ok(!same(passage.vectors[0] as Float32Array, query.vectors[0] as Float32Array), 'the prefix makes the two differ');
      });
    },
  },
  {
    name: 'order-and-count',
    async run(h) {
      await using(h, async (e) => {
        const texts = ['alpha beta', 'gamma delta', 'epsilon', 'zeta eta theta'];
        const all = await e.embedPassages(texts);
        assert.ok(all.ok);
        assert.equal(all.vectors.length, texts.length);
        for (const [i, text] of texts.entries()) {
          const one = await e.embedPassages([text]);
          assert.ok(one.ok);
          assert.ok(same(one.vectors[0] as Float32Array, all.vectors[i] as Float32Array), `vector ${String(i)} is the vector of text ${String(i)}`);
        }
        const none = await e.embedPassages([]);
        assert.ok(none.ok && none.vectors.length === 0, 'no text, no vector');
      });
    },
  },
  {
    name: 'too-long',
    async run(h) {
      await using(h, async (e) => {
        const text = h.longText(e.model);
        assert.ok((await e.countTokens(text)) > e.model.maxTokens, 'the text is over the limit');
        const r = await e.embedPassages([text]);
        // Refused, or cut to the limit as the adapter documents; either way a vector has the dimension and norm 1.
        if (r.ok) {
          assert.equal(r.vectors[0]?.length, e.model.dims);
          assert.ok(Math.abs(norm(r.vectors[0] as Float32Array) - 1) < 1e-5);
        } else {
          assert.equal(r.reason, 'too-long');
        }
      });
    },
  },
  {
    name: 'aborted',
    async run(h) {
      await using(h, async (e) => {
        const stop = new AbortController();
        stop.abort();
        for (const r of [await e.embedPassages(['a text'], { signal: stop.signal }), await e.embedQuery('a text', { signal: stop.signal })]) {
          assert.deepEqual(r, { ok: false, reason: 'aborted' });
        }
        const after = await e.embedPassages(['a text']);
        assert.ok(after.ok, 'an aborted call leaves nothing that a later one waits for');
      });
    },
  },
  {
    name: 'close-is-idempotent',
    async run(h) {
      const e = await h.make();
      await e.close();
      await e.close();
      assert.equal(e.status(), 'unavailable');
      assert.deepEqual(await e.embedPassages(['a text']), { ok: false, reason: 'unavailable' });
      assert.deepEqual(await e.embedQuery('a text'), { ok: false, reason: 'unavailable' });
    },
  },
  {
    name: 'never-throws',
    async run(h) {
      await using(h, async (e) => {
        for (const text of ['', ' ', '\u0000', '\ud800', 'a'.repeat(100_000), '🙂'.repeat(5000)]) {
          for (const call of [() => e.embedPassages([text]), () => e.embedQuery(text, { timeoutMs: 1 })]) {
            const r = await call();
            assert.ok(typeof r.ok === 'boolean', 'an answer, not an exception');
            if (r.ok) assert.equal(r.vectors[0]?.length, e.model.dims);
          }
        }
      });
    },
  },
  {
    name: 'stats-and-tokens',
    async run(h) {
      await using(h, async (e) => {
        const s = e.stats();
        assert.ok(s.threads >= 1 && s.queued >= 0 && s.chunksPerMinute >= 0);
        assert.equal(await e.countTokens(''), 0);
        assert.ok((await e.countTokens('a few words here')) >= 1);
        assert.ok((await e.countTokens('a few words here and a few more words')) > (await e.countTokens('a few')), 'more text, more tokens');
        assert.ok(e.model.dims > 0 && e.model.maxTokens > 0 && e.model.name !== '' && e.model.version !== '');
      });
    },
  },
];
