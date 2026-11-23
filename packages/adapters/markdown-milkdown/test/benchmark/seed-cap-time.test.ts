import { describe, expect, it } from 'vitest';
import { createMarkdownConverter, DEFAULT_LIMITS, seedInProcess } from '../../src/index.js';
import { ensureBuilt } from '../pool/support.js';

// The SEED direction: parser CPU time of realistic dense documents at four sizes (192, 128, 96 and 64 KiB, or the 8,000-line cap where that binds first), with the
// margin under the 5 s seed limit AND under 10 s; the realistic variant of each slow shape next to its worst case; and the cost against paragraph length at a fixed
// total size. INFORMATIONAL like the other timings (they depend on the machine): printed, flagged `UNDER 2x`, never failed on time. What fails is only what does
// not depend on the machine: a valid document within the caps that does not seed, or a hostile shape that ends any other way than a timeout or a size refusal.
const cpu = (): number => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const m = (ms: number, limit: number): string => `${(limit / Math.max(ms, 1)).toFixed(1)}x${limit / Math.max(ms, 1) < 2 ? '!' : ''}`;
const KIB = 1024;
const PARSER_ONLY = { maxSeedMarkdownBytes: 1 << 30, maxSeedLines: 1e9, maxStateBytes: 1 << 30, maxBlocks: 1e9 }; // measure the parser, not the pre-check or the state cap
/**
 * CPU time of the same parse, up to five runs (a run over 3 s ends the series). The same input is NOT the same cost every time: the parser runs in one of two modes that
 * differ by about 4x (measured: 2,184 identical lines take 130 ms or 850 ms from run to run in one process, which looks like the JIT's optimised or unoptimised code), and a
 * worker that has just started is not in the fast one. So the margin is taken on the MEDIAN, the typical run, and the least run is printed beside it.
 */
async function timedRuns(markdown: string): Promise<{ ms: number; least: number; result: Awaited<ReturnType<typeof seedInProcess>> }> {
  const times: number[] = [];
  let result = await seedInProcess('');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = cpu();
    result = await seedInProcess(markdown, PARSER_ONLY);
    const ms = cpu() - before;
    times.push(ms);
    if (ms > 3_000) break;
  }
  times.sort((x, y) => x - y);
  const mid = times.length >> 1;
  const median = times.length % 2 === 1 ? (times[mid] ?? 0) : ((times[mid - 1] ?? 0) + (times[mid] ?? 0)) / 2; // an even count averages the two middle runs (a series ends early after a run over 3 s)
  return { ms: median, least: times[0] ?? 0, result };
}
const SIZES_KIB = [64, 96, 128, 192] as const;
const SKIP_AFTER_MS = 8_000; // a shape that already took this long at a smaller size is not run at the larger ones (it only costs time)

/** The most repeats of `unit` (between `head` and `tail`) that fit `bytes` and the line cap; also which of the two bound it. */
function fill(unit: string, bytes: number, head = '', tail = ''): { text: string; bound: 'bytes' | 'lines' } {
  const fits = (k: number): boolean => Buffer.byteLength(head + unit.repeat(k) + tail) <= bytes && (head + unit.repeat(k) + tail).split('\n').length - 1 <= DEFAULT_LIMITS.maxSeedLines;
  let n = 1;
  while (fits(n * 2)) n *= 2;
  let lo = n; let hi = n * 2;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid; }
  const text = head + unit.repeat(lo) + tail;
  return { text, bound: Buffer.byteLength(head + unit.repeat(lo + 1) + tail) > bytes ? 'bytes' : 'lines' };
}

interface Shape { readonly name: string; readonly note: string; readonly build: (bytes: number) => { text: string; bound: 'bytes' | 'lines' } }
const SHAPES: readonly Shape[] = [
  { name: 'prose paragraphs', note: 'per document', build: (b) => fill('The quick brown fox jumps over the lazy dog, again and again, with *emphasis* and `code` and a [link](https://example.com/a).\n\n', b) },
  { name: 'bullets with emphasis and a link', note: 'per list', build: (b) => fill('- *item* and **bold** and [link](https://x.y/1)\n', b) },
  { name: 'task list', note: 'per list', build: (b) => fill('- [ ] task *a* done_x\n', b) },
  { name: 'link table, 6 links a row', note: 'per table', build: (b) => fill('| [a](http://x.y/1) | [b](u) | [c](u) | [d](u) | [e](u) | [f](u) |\n', b, '| h | h | h | h | h | h |\n|---|---|---|---|---|---|\n') },
  { name: 'link table, ordinary width (3 columns, 1 link)', note: 'per table', build: (b) => fill('| Item | [name](https://x.y/1) | a note |\n', b, '| a | b | c |\n|---|---|---|\n') },
  { name: 'numbered references, one tight paragraph', note: 'per paragraph', build: (b) => fill('See [1] text and [2] more [3]\n', b) },
  { name: 'numbered references, one per paragraph', note: 'per document', build: (b) => fill('[1] A. Author, A title, https://x.y/1\n\n', b) },
  { name: 'numbered references, one per list item', note: 'per list', build: (b) => fill('1. [A. Author](https://x.y/1), a title\n', b) },
  { name: 'python listing in a code block', note: 'per document', build: (b) => fill('def foo_bar_baz(a_b, c_d):\n    return a_b * c_d_e\n', b, '```python\n', '```\n') },
  { name: 'pretty JSON in a code block', note: 'per document', build: (b) => fill('  {"a_b": [1, 2, {"c": "d_e"}], "f": "*g*"},\n', b, '```json\n', '```\n') },
  { name: 'short lines (one word each)', note: 'per document', build: (b) => fill('a\n\n', b) },
];

describe('seed direction: parser CPU at four sizes, margin under 5 s and 10 s (informational)', () => {
  it('prints one row per shape and size', async () => {
    await seedInProcess('# warm up\n');
    const rows: string[] = [];
    for (const shape of SHAPES) {
      let slow = false;
      for (const kib of SIZES_KIB) {
        const { text, bound } = shape.build(kib * KIB);
        const lines = text.split('\n').length - 1;
        if (slow) { rows.push(`${shape.name.padEnd(48)} ${String(kib).padStart(3)} KiB  not run: a smaller size already took more than ${SKIP_AFTER_MS} ms`); continue; }
        const { ms, least, result } = await timedRuns(text);
        if (ms > SKIP_AFTER_MS) slow = true;
        rows.push(`${shape.name.padEnd(48)} ${String(kib).padStart(3)} KiB (${String(Buffer.byteLength(text)).padStart(6)} B, ${String(lines).padStart(5)} lines, bound: ${bound}) ${String(Math.round(ms)).padStart(6)} ms (least ${String(Math.round(least)).padStart(5)})  margin 5 s ${m(ms, 5_000).padStart(6)}  10 s ${m(ms, 10_000).padStart(6)}  [${shape.note}] ${result.ok ? 'ok' : result.reason}`);
        expect(result.ok, `${shape.name} at ${String(kib)} KiB is a valid document at the caps and must seed: ${result.ok ? '' : result.reason}`).toBe(true);
      }
    }
    process.stdout.write(`\nseed parser CPU by shape and size ("!" = under 2x):\n${rows.join('\n')}\n`);
  }, 900_000);

  // Cost against paragraph length at a fixed total size (64 KiB): the same text, cut into paragraphs of L lines by blank lines.
  it.each([
    ['numbered references', 'See [1] text and [2] more [3]\n'],
    ['link table rows as a paragraph (no table header)', '[a](http://x.y/1) [b](u) [c](u) [d](u) [e](u) [f](u)\n'],
  ])('%s: cost against lines per paragraph at 64 KiB total', async (name, line) => {
    await seedInProcess('# warm up\n');
    const total = 64 * KIB;
    const rows: string[] = [];
    let crossed: number | undefined;
    for (const perParagraph of [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]) {
      const unit = `${line.repeat(perParagraph)}\n`;
      if (Buffer.byteLength(unit) > total) break;
      const { text } = fill(unit, total);
      const { ms, least, result } = await timedRuns(text);
      if (crossed === undefined && ms > 1_000) crossed = perParagraph;
      rows.push(`${String(perParagraph).padStart(5)} lines per paragraph: ${String(Math.round(ms)).padStart(6)} ms (least ${String(Math.round(least)).padStart(5)}) ${result.ok ? 'ok' : result.reason}`);
      expect(result.ok, `${name} at ${String(perParagraph)} lines per paragraph must seed: ${result.ok ? '' : result.reason}`).toBe(true);
      if (ms > SKIP_AFTER_MS) break;
    }
    process.stdout.write(`\nseed cost against paragraph length, ${name}, 64 KiB total:\n${rows.join('\n')}\ncrosses 1 s at: ${crossed === undefined ? 'not reached' : `${String(crossed)} lines per paragraph`}\n`);
    expect(rows.length).toBeGreaterThan(0);
  }, 600_000);
});

describe('seed through the pool at the production limits: the hostile shapes are stopped by the limit', () => {
  it('prints the wall time of the two hostile shapes at 192 KiB', async () => {
    ensureBuilt();
    const pool = createMarkdownConverter({ poolSize: 1 });
    try {
      for (const [name, unit] of [['unmatched emphasis runs', '*a_ '], ['closing brackets', ']']] as const) {
        const { text } = fill(unit, 192 * KIB);
        const started = performance.now();
        const result = await pool.seed(text, 'bench');
        process.stdout.write(`\nhostile ${name}, 192 KiB, pool: ${Math.round(performance.now() - started)} ms (limit 5000 ms) ${result.ok ? 'ok' : result.reason}\n`);
        expect(result.ok || result.reason === 'timeout' || result.reason === 'too-large', name).toBe(true);
      }
    } finally { await pool.close(); }
  }, 120_000);
});
