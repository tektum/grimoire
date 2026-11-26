import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { embedderConformance } from '@tektum/grimoire-core/testing/embedder-conformance';
import type { SemanticConfig } from '@tektum/grimoire-core/ports/config';
import { describe, expect, it } from 'vitest';
import { createOnnxEmbedder } from '../src/embedder.js';

// The Embedder conformance suite on the real models. Needs the model files (`node scripts/fetch-models.mjs`, or the image's /app/models) and the compiled worker (`bun run build`): it runs
// inside the built image (`docker run`), where both are, and where it is run again with no network, a read-only root filesystem and no capabilities.
const modelDir = process.env['GRIMOIRE_MODEL_DIR'] ?? '/app/models';
// A full GC on demand with no flag on the command line, so that the heap the test measures is the live one.
v8.setFlagsFromString('--expose-gc');
const fullGc = vm.runInNewContext('gc') as () => void;

const configOf = (model: SemanticConfig['model']): SemanticConfig => ({
  enabled: true,
  model,
  modelDir,
  threads: 2,
  debounceSeconds: 30,
  sweepSeconds: 15,
  maxChunksPerMinute: 600,
  queryTimeoutMs: 1500,
  minSimilarity: 0,
  candidates: 100,
});

for (const model of ['multilingual-e5-base', 'multilingual-e5-small'] as const) {
  describe(`the ${model} embedder`, () => {
    const harness = {
      async make() {
        const e = createOnnxEmbedder(configOf(model), { lockFile: path.join(modelDir, 'models.lock.json'), workerUrl: new URL('../dist/worker.js', import.meta.url) });
        const deadline = Date.now() + 120_000;
        while (e.status() !== 'ready') {
          if (Date.now() > deadline) throw new Error(`the model did not load: ${e.status()}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return e;
      },
      longText: () => 'The quick brown fox jumps over the lazy dog. '.repeat(120),
    };
    for (const c of embedderConformance) it(c.name, { timeout: 180_000 }, () => c.run(harness));

    it("takes a text that counts model.maxTokens tokens: the room for the special tokens and the prefix is the adapter's", { timeout: 180_000 }, async () => {
      const e = await harness.make();
      try {
        const words = 'The quick brown fox jumps over the lazy dog while the quarterly plan waits for review. '.split(' ');
        let text = '';
        for (let i = 0; (await e.countTokens(text)) < e.model.maxTokens; i += 1) text += `${words[i % words.length] as string} `;
        while ((await e.countTokens(text)) > e.model.maxTokens) text = text.slice(0, -2);
        expect(await e.countTokens(text)).toBeLessThanOrEqual(e.model.maxTokens);
        expect(await e.countTokens(text)).toBeGreaterThan(e.model.maxTokens - 4);
        for (const call of [() => e.embedPassages([text]), () => e.embedQuery(text)]) expect(await call()).toMatchObject({ ok: true });
      } finally {
        await e.close();
      }
    });

    // The tokenizer is 160 MB of live objects. On the server's heap every full GC walks them and stops the event loop (150 ms and more on a loaded runner: the red of the event-loop test); on the model's
    // thread the server's heap does not grow with the model. The measure is bytes, not time, so it does not depend on the machine.
    it('keeps the tokenizer off the heap of this thread: the heap grows by less than 40 MB while the model loads and counts', { timeout: 180_000 }, async () => {
      fullGc();
      const before = v8.getHeapStatistics().used_heap_size;
      const e = await harness.make();
      try {
        expect(await e.countTokens('a few words to count')).toBeGreaterThan(0);
        fullGc();
        expect((v8.getHeapStatistics().used_heap_size - before) / 1e6).toBeLessThan(40);
      } finally {
        await e.close();
      }
    });

    it('has the model dimensions and ranks a paraphrase above an unrelated text', { timeout: 180_000 }, async () => {
      const e = await harness.make();
      try {
        expect(e.model.dims).toBe(model === 'multilingual-e5-base' ? 768 : 384);
        const q = await e.embedQuery('how do I sign in to the app');
        const p = await e.embedPassages(['Logging in needs a token from the identity provider.', 'Bananas are yellow and grow in bunches.']);
        if (!q.ok || !p.ok) throw new Error('embedding failed');
        const dot = (a: Float32Array, b: Float32Array): number => a.reduce((sum, x, i) => sum + x * (b[i] as number), 0);
        expect(dot(q.vectors[0] as Float32Array, p.vectors[0] as Float32Array)).toBeGreaterThan(dot(q.vectors[0] as Float32Array, p.vectors[1] as Float32Array));
      } finally {
        await e.close();
      }
    });
  });
}
