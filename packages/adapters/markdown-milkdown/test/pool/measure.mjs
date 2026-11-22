// Manual measurement for docs/proof/m2-pool.md (not part of `bun run test`): node test/pool/measure.mjs [oom-count]
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { convertInProcess, createMarkdownConverter } from '../../dist/index.js';
import { generateMarkdown } from '../../dist/testing/generate.js';
import { stateFromMarkdown } from '../../dist/testing/states.js';

const fixture = fileURLToPath(new URL('./fixtures/behaviours.mjs', import.meta.url));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = async (fn) => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};
const out = {};

const sizes = { '10KB': generateMarkdown('mixed', 10_000), '100KB': generateMarkdown('mixed', 100_000), 'cap (0.9MB md, 1.5MB state)': generateMarkdown('prose', 880_000) };
const states = {};
for (const [name, md] of Object.entries(sizes)) states[name] = await stateFromMarkdown(md);

// Cold start: a fresh pool, first conversion (worker boot, module load, headless context), vs. in process in this process.
{
  const small = states['10KB'];
  const t0 = performance.now();
  const pool = createMarkdownConverter();
  const first = await pool.toMarkdown(small);
  out.coldStartPoolMs = Math.round(performance.now() - t0);
  out.coldStartOk = first.ok;
  out.secondCallPoolMs = Math.round(await time(() => pool.toMarkdown(small)));
  await pool.close();
}

const pool = createMarkdownConverter();
await pool.toMarkdown(states['10KB']);
out.overhead = {};
for (const [name, state] of Object.entries(states)) {
  const runs = name.startsWith('cap') ? 5 : 15;
  await convertInProcess(state);
  const inProc = [];
  const pooled = [];
  for (let i = 0; i < runs; i += 1) {
    inProc.push(await time(() => convertInProcess(state)));
    pooled.push(await time(() => pool.toMarkdown(state)));
  }
  out.overhead[name] = { stateBytes: state.byteLength, runs, inProcessMs: +median(inProc).toFixed(1), poolMs: +median(pooled).toFixed(1), overheadMs: +(median(pooled) - median(inProc)).toFixed(1) };
}

// Event loop of the main thread during a cap-sized conversion: in the pool, and in process for contrast.
const delayDuring = async (fn) => {
  const h = monitorEventLoopDelay({ resolution: 10 });
  // Longest gap between two 10 ms timer ticks: a loop blocked by in-process work shows up here (the histogram only
  // records a sample when a tick finally fires).
  let last = performance.now();
  let maxGap = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  h.enable();
  await fn();
  await new Promise((resolve) => setTimeout(resolve, 30));
  h.disable();
  clearInterval(ticker);
  return { histogramMaxMs: +(h.max / 1e6).toFixed(1), maxTickGapMs: +maxGap.toFixed(1) };
};
const cap = states['cap (0.9MB md, 1.5MB state)'];
out.eventLoopDuringCapPool = await delayDuring(() => pool.toMarkdown(cap));
out.eventLoopDuringCapInProcess = await delayDuring(() => convertInProcess(cap));
await pool.close();

// Memory of this process over repeated out-of-memory conversions (the worker's heap is not ours).
const count = Number(process.argv[2] ?? 200);
const oom = createMarkdownConverter({ workerPath: fixture, heapMb: 64 });
await oom.seed('echo', 'test-key');
const mem = () => {
  globalThis.gc?.();
  const m = process.memoryUsage();
  return { rssMb: Math.round(m.rss / 1048576), heapUsedMb: +(m.heapUsed / 1048576).toFixed(1) };
};
const before = mem();
let failures = 0;
const t0 = performance.now();
for (let i = 0; i < count; i += 1) if ((await oom.seed('alloc', 'test-key')).reason === 'out-of-memory') failures += 1;
const afterRun = mem();
const stillServes = (await oom.seed('echo', 'test-key')).ok;
await oom.close();
out.oom = { count, failures, totalMs: Math.round(performance.now() - t0), before, after: afterRun, stillServes, threadsAfterClose: oom.stats().threads };
console.log(JSON.stringify(out, null, 2));
