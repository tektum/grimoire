import { describe, expect, it } from 'vitest';
import { convertInProcess, createMarkdownConverter } from '../../src/index.js';
import { SHAPES } from '../../src/testing/hostile-shapes.js';
import type { Shape } from '../../src/testing/hostile-shapes.js';
import { stateFromDocJson } from '../../src/testing/states.js';
import { ensureBuilt } from '../pool/support.js';

/**
 * CPU time of one conversion of an adversarial document (review finding F1). Measured with `process.cpuUsage` (one core,
 * the conversion is synchronous), so a loaded machine does not fail it.
 *
 * Budget: 5 s of CPU per conversion at the largest state the converter accepts (1,536,000 bytes) on the development machine
 * (32 cores, Node 26); the worker's own timeout is 10 s. Growth: from 100 KB to 500 KB the time may grow at most 8-fold
 * (linear is 5; the rest is slack for the garbage collector), so a quadratic cost (25-fold) fails. A refusal with a typed
 * reason is a pass: it is cheap and the page keeps its live state.
 *
 * Shapes in `SLOWER_THAN_THE_LIMIT` make the Markdown parser (the verifying parse of a save) super-linear. There is no pre-check for them
 * any more: the save direction's time limit is the bound. For those the test asserts that, at the state cap, the pooled converter
 * ends in a `timeout` (the worker replaced, the next save working) or finishes within the limit.
 */
const SLOWER_THAN_THE_LIMIT = [
  'closing brackets', 'alternating strong and plain runs', 'alternating emphasis and strong runs',
  'alternating nested marks', 'text with edge spaces around marks', // mildly super-linear (8-10x for 5x the size); 3.7 s at the cap
];
const BUDGET_MS = 5_000;
const MAX_GROWTH = 8;
const CAP_BYTES = 1_536_000;

const cpu = (): number => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};

async function measure(shape: Shape, size: number): Promise<{ ms: number; bytes: number; outcome: string }> {
  const state = await stateFromDocJson(shape.build(size));
  const before = cpu();
  const result = await convertInProcess(state);
  return { ms: cpu() - before, bytes: state.byteLength, outcome: result.ok ? 'ok' : result.reason };
}

/** The size (characters or runs) whose state is just under the cap: scaled from a small build, then trimmed until it fits. */
async function capSize(shape: Shape): Promise<number> {
  const probe = shape.unit === 'characters' ? 20_000 : 2_000;
  const { bytes } = await measure(shape, probe);
  let size = Math.floor((probe * (CAP_BYTES * 0.98)) / bytes);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    size -= size % 20;
    const state = await stateFromDocJson(shape.build(size));
    if (state.byteLength <= CAP_BYTES) return size;
    size = Math.floor(size * 0.93);
  }
  return size;
}

describe('time-limited shapes: the time limit is the bound', () => {
  it.each(SLOWER_THAN_THE_LIMIT)('%s: at the state cap the pooled save finishes or stops at its limit, and the next save works', async (name) => {
    ensureBuilt();
    const shape = SHAPES.find((candidate) => candidate.name === name);
    if (!shape) throw new Error(name);
    const state = await stateFromDocJson(shape.build(await capSize(shape)));
    const pool = createMarkdownConverter({ poolSize: 1, timeoutMs: 10_000 });
    try {
      const result = await pool.toMarkdown(state);
      expect(result.ok || result.reason === 'timeout' || result.reason === 'too-large').toBe(true);
      const small = await pool.seed('# next\n', 'next');
      if (!small.ok) throw new Error(small.detail);
      expect((await pool.toMarkdown(small.state)).ok).toBe(true);
      process.stdout.write(`\ncpu ${name}: at the cap ${result.ok ? 'ok' : result.reason}\n`);
    } finally { await pool.close(); }
  }, 120_000);
});

describe('conversion time of adversarial documents: bounded, and no worse than about linear', () => {
  it.each(SHAPES.filter((shape) => !SLOWER_THAN_THE_LIMIT.includes(shape.name)).map((shape) => [shape.name, shape] as const))('%s', async (_name, shape) => {
    await measure(shape, 1_000); // warm the headless context
    const small = shape.unit === 'characters' ? 100_000 : 3_000;
    const middle = shape.unit === 'characters' ? 500_000 : 15_000;
    const one = await measure(shape, small);
    // Fail at the smallest size first: a quadratic shape must not make this test run for minutes.
    expect(one.ms, `${shape.name} at ${small}: ${Math.round(one.ms)}ms`).toBeLessThan(BUDGET_MS);
    const five = await measure(shape, middle);
    expect(five.ms, `${shape.name} at ${middle}: ${Math.round(five.ms)}ms`).toBeLessThan(BUDGET_MS);
    const cap = await measure(shape, await capSize(shape));
    const line = `${shape.name}: ${small}:${Math.round(one.ms)}ms ${middle}:${Math.round(five.ms)}ms cap(${Math.round(cap.bytes / 1000)}KB):${Math.round(cap.ms)}ms ${cap.outcome}`;
    process.stdout.write(`\ncpu ${line}\n`);
    expect(cap.ms, line).toBeLessThan(BUDGET_MS);
    expect(['ok', 'too-large', 'too-deep']).toContain(cap.outcome);
    if (one.ms > 150 && five.outcome === one.outcome) expect(five.ms / one.ms, line).toBeLessThan(MAX_GROWTH);
  }, 120_000);
});
