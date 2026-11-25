import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createOnnxEmbedder } from '@tektum/grimoire-adapter-embedder-onnx';
import type { SemanticConfig } from '@tektum/grimoire-core/ports/config';
import { describe, expect, it } from 'vitest';
import { evaluate, loadCorpus } from './quality.js';

// The quality and the cost of the two models, measured on the real files (`node scripts/fetch-models.mjs`, the image's /app/models, or GRIMOIRE_MODEL_DIR) and the compiled worker (`bun run build`).
// What it prints is what `docs/proof/m7-semantic-quality.md` records; GRIMOIRE_QUALITY_OUT names a file to write it to as JSON.
const modelDir = process.env['GRIMOIRE_MODEL_DIR'] ?? '/app/models';
const run = promisify(execFile);
const MODELS = ['multilingual-e5-base', 'multilingual-e5-small'] as const;
/** The recall at 5 the default model must reach on the corpus (the small model's is recorded, not required). */
const BASE_RECALL = 0.8;
/** The most the process may hold at its peak (the measurement of the plan was 0.87 GB and 0.70 GB). */
const PEAK_RSS_MB = { 'multilingual-e5-base': 1.1 * 1024, 'multilingual-e5-small': 0.9 * 1024 } as const;

const measured: Record<string, unknown> = {};
const record = (model: string, part: string, value: unknown): void => {
  measured[model] = { ...(measured[model] as object | undefined), [part]: value };
  if (process.env['GRIMOIRE_QUALITY_OUT'] !== undefined) writeFileSync(process.env['GRIMOIRE_QUALITY_OUT'], JSON.stringify(measured, null, 2));
  console.log(JSON.stringify({ model, [part]: value }));
};

for (const model of MODELS) {
  describe(`the ${model} embedder`, () => {
    it('finds the passage that answers a query among the five most similar (recall at 5), and says how far a search that matches nothing still gets', { timeout: 300_000 }, async () => {
      const config: SemanticConfig = { enabled: true, model, modelDir, threads: 2, debounceSeconds: 30, sweepSeconds: 15, maxChunksPerMinute: 600, queryTimeoutMs: 1500, minSimilarity: 0, candidates: 100 };
      const e = createOnnxEmbedder(config, { lockFile: path.join(modelDir, 'models.lock.json') });
      try {
        const deadline = Date.now() + 120_000;
        while (e.status() !== 'ready') {
          if (Date.now() > deadline) throw new Error(`the model did not load: ${e.status()}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const quality = await evaluate(e, loadCorpus());
        record(model, 'quality', quality);
        if (model === 'multilingual-e5-base') expect(quality.recallAt5, `misses: ${JSON.stringify(quality.misses)}`).toBeGreaterThanOrEqual(BASE_RECALL);
        expect(quality.nonsenseSimilarity).toHaveLength(10);
      } finally {
        await e.close();
      }
    });

    it('stays within the memory of its budget after loading and after 200 chunks, and says how many chunks a second it embeds at 1, 2 and 4 threads', { timeout: 300_000 }, async () => {
      const probe = path.resolve(import.meta.dirname, 'memory-probe.mjs');
      const { stdout } = await run(process.execPath, [probe, model], { env: { ...process.env, GRIMOIRE_MODEL_DIR: modelDir }, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout.trim().split('\n').pop() as string) as { peakRssMB: number; rssAfterLoadMB: number; rssAfter200ChunksMB: number; chunksPerSecond: Record<string, number> };
      record(model, 'cost', result);
      expect(result.peakRssMB).toBeLessThanOrEqual(PEAK_RSS_MB[model]);
      expect(result.rssAfter200ChunksMB).toBeGreaterThan(0);
      for (const threads of ['1', '2', '4']) expect(result.chunksPerSecond[threads]).toBeGreaterThan(0);
    });
  });
}
