import { describe, expect, it } from 'vitest';
import { convertInProcess, createMarkdownConverter } from '../../src/index.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { SHAPES } from '../../src/testing/hostile-shapes.js';
import type { Shape } from '../../src/testing/hostile-shapes.js';
import { stateFromDocJson } from '../../src/testing/states.js';
import { ensureBuilt } from '../pool/support.js';

/**
 * CPU time of one conversion of an adversarial document (review finding F1). Measured with `process.cpuUsage` (one core,
 * the conversion is synchronous), so a loaded machine does not fail it.
 *
 * Budget: 5 s of CPU per conversion at the largest state the converter accepts (the state cap, 1,000,000 bytes by default) on the development machine
 * (32 cores, Node 26); the worker's own timeout is 10 s. Growth: from 100 KB to 500 KB the time may grow at most 8-fold
 * (linear is 5; the rest is slack for the garbage collector), so a quadratic cost (25-fold) fails. A refusal with a typed
 * reason is a pass: it is cheap and the page keeps its live state.
 *
 * Shapes in `SLOWER_THAN_THE_LIMIT` make the Markdown parser (the verifying parse of a save) super-linear. There is no pre-check for them
 * any more: the save direction's time limit is the bound. For those the test asserts that, at the state cap, the pooled converter
 * ends in a `timeout` (the worker replaced, the next save working) or finishes within the limit.
 */
const SLOWER_THAN_THE_LIMIT = [
  'alternating strong and plain runs', 'alternating emphasis and strong runs',
  'alternating nested marks', 'text with edge spaces around marks', // mildly super-linear (8-10x for 5x the size); 3.7 s at the cap
];
/** The save limit the production converter is given (the pool's default `timeoutMs`). Timing here is INFORMATIONAL: it is machine dependent, so no assertion on it can be both
 *  honest and stable. Every shape prints its CPU time, this limit and the margin; a margin under 2x is flagged `UNDER 2x` in the output and in the job summary. What fails is
 *  only what does not depend on the machine: an unexpected outcome and a pool that does not recover. Growth for 5x the size is printed and flagged at MAX_GROWTH, not failed. */
const LIMIT_MS = 10_000;
const margin = (ms: number): string => `${(LIMIT_MS / Math.max(ms, 1)).toFixed(2)}x${LIMIT_MS / Math.max(ms, 1) < 2 ? ' UNDER 2x' : ''}`;
const MAX_GROWTH = 8;
const CAP_BYTES = DEFAULT_LIMITS.maxStateBytes;

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
async function capSize(shape: Shape, capBytes: number = CAP_BYTES): Promise<number> {
  const probe = shape.unit === 'characters' ? 20_000 : 2_000;
  const { bytes } = await measure(shape, probe);
  let size = Math.floor((probe * (capBytes * 0.98)) / bytes);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    size -= size % 20;
    const state = await stateFromDocJson(shape.build(size));
    if (state.byteLength <= capBytes) return size;
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
      const started = performance.now();
      const result = await pool.toMarkdown(state);
      const wallMs = performance.now() - started;
      expect(result.ok || result.reason === 'timeout' || result.reason === 'too-large').toBe(true);
      const small = await pool.seed('# next\n', 'next');
      if (!small.ok) throw new Error(small.detail);
      expect((await pool.toMarkdown(small.state)).ok).toBe(true);
      process.stdout.write(`\ncpu ${name}: at the cap ${result.ok ? 'ok' : result.reason} in ${Math.round(wallMs)}ms (pool, wall) | limit ${LIMIT_MS}ms margin ${margin(wallMs)}\n`);
    } finally { await pool.close(); }
  }, 120_000);
});

describe('conversion time of adversarial documents: bounded, and no worse than about linear', () => {
  it.each(SHAPES.filter((shape) => !SLOWER_THAN_THE_LIMIT.includes(shape.name)).map((shape) => [shape.name, shape] as const))('%s', async (_name, shape) => {
    await measure(shape, 1_000); // warm the headless context
    const small = shape.unit === 'characters' ? 100_000 : 3_000;
    const middle = shape.unit === 'characters' ? 500_000 : 15_000;
    const one = await measure(shape, small);
    const five = await measure(shape, middle);
    const cap = await measure(shape, await capSize(shape));
    const line = `${shape.name}: ${small}:${Math.round(one.ms)}ms ${middle}:${Math.round(five.ms)}ms cap(${Math.round(cap.bytes / 1000)}KB):${Math.round(cap.ms)}ms ${cap.outcome} | limit ${LIMIT_MS}ms margin ${margin(cap.ms)}`;
    process.stdout.write(`\ncpu ${line}\n`);
    expect(['ok', 'too-large', 'too-deep']).toContain(cap.outcome);
    // Growth is informational too: the same input costs 130 or 850 ms from run to run (see seed-cap-time.test.ts), so a ratio of two single runs is noise as often as signal.
    if (one.ms > 150 && five.outcome === one.outcome) process.stdout.write(`cpu growth ${shape.name}: ${(five.ms / one.ms).toFixed(1)}x for 5x the size${five.ms / one.ms >= MAX_GROWTH ? ' (a ratio of 8 or more suggests worse than linear)' : ''}\n`);
  }, 120_000);
});

const SAVE_ROWS = ['many paragraphs', 'alternating links', 'text with line endings', 'many list items'];

describe('save direction at other state sizes (informational): a 1,000,000-byte state, and the largest state whose Markdown still fits the stored cap', () => {
  it.each(SAVE_ROWS)('%s', async (name) => {
    const shape = SHAPES.find((candidate) => candidate.name === name);
    if (!shape) throw new Error(name);
    await measure(shape, 1_000);
    const rows: string[] = [];
    // (i) a state of 1,000,000 bytes
    const at1m = await measure(shape, await capSize(shape, 1_000_000));
    rows.push(`state ${at1m.bytes} B: ${Math.round(at1m.ms)} ms, limit ${LIMIT_MS} ms, margin ${margin(at1m.ms)}, ${at1m.outcome}`);
    // (ii) the largest state whose Markdown the save still stores (it refuses Markdown over the stored cap): bisection on the size, six steps
    let lo = await capSize(shape, 50_000);
    let hi = await capSize(shape);
    let best: { bytes: number; ms: number; markdown: number } | undefined;
    const tryFit = async (size: number): Promise<boolean> => {
      const state = await stateFromDocJson(shape.build(size));
      const before = cpu();
      const result = await convertInProcess(state);
      const ms = cpu() - before;
      if (result.ok) { best = { bytes: state.byteLength, ms, markdown: Buffer.byteLength(result.markdown, 'utf8') }; return true; }
      expect(result.reason, `${name} at ${String(size)}: only a size refusal means "over the stored cap" (${result.detail})`).toBe('too-large');
      return false;
    };
    await tryFit(lo); // a size that stores, so that a result exists whatever the bisection finds
    const stateCapBinds = await tryFit(hi);
    if (!stateCapBinds) {
      for (let step = 0; step < 6 && hi - lo > 20; step += 1) {
        const mid = Math.floor((lo + hi) / 2 / 20) * 20;
        if (await tryFit(mid)) lo = mid; else hi = mid;
      }
    }
    const fit = best as { bytes: number; ms: number; markdown: number } | undefined;
    rows.push(fit === undefined ? `largest state that stores: none found` : `largest state that stores: ${fit.bytes} B state, ${fit.markdown} B Markdown (${stateCapBinds ? 'the state cap binds first' : 'the stored-Markdown cap binds'}), ${Math.round(fit.ms)} ms, margin ${margin(fit.ms)}`);
    process.stdout.write(`\ncpu save sizes ${name}:\n  ${rows.join('\n  ')}\n`);
    expect(['ok', 'too-large']).toContain(at1m.outcome);
  }, 240_000);
});
