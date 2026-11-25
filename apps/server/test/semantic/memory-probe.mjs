// Run by quality.container.test.ts in a process of its own per model, so that what it measures is the embedder's: the process RSS after the model is loaded, after 200 chunks of about 200 tokens,
// the peak of the first embedder (load and 200 chunks), and the chunks a second at 1, 2 and 4 threads. Prints one line of JSON.
//   node memory-probe.mjs <multilingual-e5-base|multilingual-e5-small>        (GRIMOIRE_MODEL_DIR as for the other container tests; the embedder is the workspace package, built)
const model = process.argv[2];
const modelDir = process.env.GRIMOIRE_MODEL_DIR ?? '/app/models';
const { createOnnxEmbedder } = await import('@tektum/grimoire-adapter-embedder-onnx');
import { readFileSync } from 'node:fs';
const mb = (bytes) => Math.round(bytes / 1048576);
/** The process's own high-water mark of resident memory (`VmHWM`): getrusage's maxRSS starts from the parent's size when the parent forked this process, so it would report the test runner's. */
const peakMB = () => Math.round(Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? 0) / 1024);
const config = (threads) => ({ enabled: true, model, modelDir, threads, debounceSeconds: 30, sweepSeconds: 15, maxChunksPerMinute: 600, queryTimeoutMs: 1500, minSimilarity: 0, candidates: 100 });

async function ready(threads) {
  const e = createOnnxEmbedder(config(threads));
  const started = Date.now();
  while (e.status() !== 'ready') {
    if (Date.now() - started > 120_000) throw new Error(`the model did not load: ${e.status()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return e;
}
const sentence = 'The quarterly planning meeting covered hiring, the budget for the next year, and how the platform team will migrate its services to the new cluster before the end of March. ';
const chunk = (e, n) => {
  let text = '';
  while (e.countTokens(text) < 195) text += sentence;
  return `${text} ${String(n)}`;
};

const result = { model };
const e = await ready(2);
result.tokensPerChunk = e.countTokens(chunk(e, 0));
result.rssAfterLoadMB = mb(process.memoryUsage().rss);
const texts = Array.from({ length: 200 }, (_, i) => chunk(e, i));
const r = await e.embedPassages(texts);
if (!r.ok) throw new Error(`200 chunks were not embedded: ${r.reason}`);
result.rssAfter200ChunksMB = mb(process.memoryUsage().rss);
// The peak of this one embedder, taken before the others of the throughput runs below are loaded: a closed one has not given all its memory back by then.
result.peakRssMB = peakMB();
await e.close();
result.chunksPerSecond = {};
for (const threads of [1, 2, 4]) {
  const t = await ready(threads);
  await t.embedPassages(texts.slice(0, 8));
  const started = performance.now();
  const out = await t.embedPassages(texts.slice(0, 48));
  if (!out.ok) throw new Error('throughput run failed');
  result.chunksPerSecond[threads] = Number((48 / ((performance.now() - started) / 1000)).toFixed(1));
  await t.close();
}
console.log(JSON.stringify(result));
process.exit(0);
