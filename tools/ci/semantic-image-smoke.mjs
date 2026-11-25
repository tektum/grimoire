// Run INSIDE the built application image, by the `Image and stack` job: the embedder on the real models, on the distroless base, with no network, a read-only root filesystem, every capability
// dropped and no TMPDIR. It loads each model (so the ONNX runtime's native library loads on that base), embeds, checks what every embedder promises, and prints one line of JSON a model.
//   docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges -v "$PWD/tools/ci/semantic-image-smoke.mjs:/smoke.mjs:ro" --entrypoint /nodejs/bin/node IMAGE /smoke.mjs
// Exit 0 when both models pass, 1 on a failed check. The paths are the image's; the two variables let the same file run on a checkout, which the `Semantic models` job does with the models it fetched.
import assert from 'node:assert/strict';

const modelDir = process.env.GRIMOIRE_MODEL_DIR ?? '/app/models';
const { createOnnxEmbedder } = await import(process.env.EMBEDDER_MODULE ?? '/app/packages/adapters/embedder-onnx/dist/index.js');
const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const same = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
const dims = { 'multilingual-e5-base': 768, 'multilingual-e5-small': 384 };

let failed = false;
for (const model of Object.keys(dims)) {
  const events = [];
  const log = { error: (event, fields) => events.push({ event, fields }), debug() {}, info() {}, warn() {}, child() { return log; } };
  const e = createOnnxEmbedder({ enabled: true, model, modelDir, threads: 2, debounceSeconds: 30, sweepSeconds: 15, maxChunksPerMinute: 600, queryTimeoutMs: 1500, minSimilarity: 0, candidates: 100 }, { log });
  try {
    const started = Date.now();
    while (e.status() !== 'ready') {
      if (Date.now() - started > 120_000) throw new Error(`not ready after 120 s: ${e.status()} ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const loadMs = Date.now() - started;
    const texts = ['the quarterly plan', 'a recipe for soup'];
    const a = await e.embedPassages(texts);
    const b = await e.embedPassages([texts[0]]);
    const q = await e.embedQuery(texts[0]);
    assert.ok(a.ok && b.ok && q.ok, 'embedding works');
    assert.equal(a.vectors[0].length, dims[model]);
    for (const v of [...a.vectors, ...q.vectors]) assert.ok(Math.abs(norm(v) - 1) < 1e-5, 'norm 1');
    assert.ok(same(a.vectors[0], b.vectors[0]), 'the same text, the same vector');
    assert.ok(!same(a.vectors[0], q.vectors[0]), 'a query is not a passage');
    assert.deepEqual(await e.embedPassages(['word '.repeat(2000)]), { ok: false, reason: 'too-long' });
    assert.deepEqual(events, [], 'nothing was reported unavailable');
    const t = performance.now();
    for (let i = 0; i < 10; i += 1) assert.ok((await e.embedPassages([`${'The quarterly planning meeting covered hiring and the budget. '.repeat(15)}${String(i)}`])).ok);
    console.log(JSON.stringify({ model, ok: true, loadMs, tokens: e.countTokens('word '.repeat(10)), textsPerSecond: Number((10 / ((performance.now() - t) / 1000)).toFixed(1)), rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ model, ok: false, error: String(error.message ?? error).slice(0, 300) }));
  } finally {
    await e.close();
  }
}
process.exit(failed ? 1 : 0);
