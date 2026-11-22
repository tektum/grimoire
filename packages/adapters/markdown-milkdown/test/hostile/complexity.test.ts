import { beforeAll, describe, expect, it } from 'vitest';
import { convertInProcess, createMarkdownConverter } from '../../src/index.js';
import { ensureBuilt } from '../pool/support.js';
import { SHAPES } from '../../src/testing/hostile-shapes.js';
import { stateFromDocJson } from '../../src/testing/states.js';

const cpu = (): number => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};
/** The least CPU time (ms) of three runs of `run`: a refusal before the parser costs milliseconds every time, a regression costs seconds every time, and a busy machine inflates only some runs. */
async function leastCpu(run: () => Promise<unknown>): Promise<{ ms: number; last: unknown }> {
  let ms = Number.POSITIVE_INFINITY;
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = cpu();
    last = await run();
    ms = Math.min(ms, cpu() - before);
  }
  return { ms, last };
}

// The delimiter budget that used to refuse these shapes is gone (it also refused valid dense pages). Every input it was built and reviewed against stays here, now
// against what protects the server: the size, line and marker pre-check, and above all the seed time limit with the per-caller isolation of the pool. For each shape the
// seed must settle within the limit (an answer, or a refusal), and the same converter must serve an ordinary page right after, for another caller.
const HOSTILE: readonly (readonly [string, string])[] = [
  ['30,000 unescaped closing brackets in one paragraph', ']'.repeat(30_000)],
  ['unmatched emphasis', '*a'.repeat(30_000)],
  ['alternating strong', '**a**a'.repeat(10_000)],
  ['strike-through', '~~a'.repeat(20_000)],
  ['underscores', '_a'.repeat(30_000)],
  ['backtick pairs', '`a'.repeat(30_000)],
  ['120,000 escaped opening brackets', '\\['.repeat(120_000)],
  ['40,000 escaped opening brackets', '\\['.repeat(40_000)],
  ['a quote run with lone ">" lines (one run)', Array.from({ length: 20_000 }, () => '> *x* **y**').join('\n>\n')],
  ['a quote run with blank lines', Array.from({ length: 20_000 }, () => '> *x* **y**').join('\n\n')],
  ['a fence full of asterisks', ['```', '*'.repeat(200_000), '```', ''].join('\n')],
  ['a table of 20,000 emphasised rows', ['| a | b |', '| - | - |', ...Array.from({ length: 20_000 }, () => '| *x* | **y** |')].join('\n')],
  ['a tight list of 20,000 items with emphasis and links', Array.from({ length: 20_000 }, (_, i) => `- *item ${i}* and **bold** and [link](https://x.y/${i})`).join('\n')],
  ['two fences with asterisks between ``` and ~~~', ['```', '*'.repeat(50_000), '~~~', '*'.repeat(50_000), '```', ''].join('\n')],
  ['a fence, then unmatched emphasis', ['```', 'x', '```', '*a'.repeat(30_000), ''].join('\n')],
  ['many separate paragraphs of emphasis', Array.from({ length: 30_000 }, () => '*a* **b** `c`').join('\n\n')],
];

describe('hostile shapes of the retired delimiter budget: bounded by the seed limits, the converter stays healthy', () => {
  beforeAll(() => { ensureBuilt(); });
  const LIMIT_MS = 1_500;
  it.each(HOSTILE)('%s', async (_name, markdown) => {
    const converter = createMarkdownConverter({ seedTimeoutMs: LIMIT_MS });
    try {
      const started = Date.now();
      const result = await converter.seed(markdown, 'hostile-caller');
      // The limit, plus the time to stop a worker and start another, plus a busy machine: far below what these shapes cost without the limit (seconds to minutes).
      expect(Date.now() - started).toBeLessThan(LIMIT_MS + 8_000);
      if (!result.ok) expect(['too-large', 'timeout']).toContain(result.reason);
      expect(await converter.seed('# Ordinary\n\nA small page.', 'someone-else')).toMatchObject({ ok: true });
    } finally { await converter.close(); }
  }, 60_000);

  it('an ordinary dense page (1,000 list items with emphasis and a link each) is seeded, not refused', async () => {
    const converter = createMarkdownConverter();
    try {
      const dense = Array.from({ length: 1000 }, (_, i) => `- *item ${i}* and **bold** and [link](https://x.y/${i})`).join('\n');
      expect(await converter.seed(dense, 'ordinary')).toMatchObject({ ok: true });
    } finally { await converter.close(); }
  }, 60_000);
});
describe('a block with a huge number of children is refused before the serializer (it copies the child list once per child)', () => {
  it('one raw html node of 62,500 whole elements splits into 187,500 children: refused within 5 s of CPU, not after 100 s', async () => {
    const shape = SHAPES.find((candidate) => candidate.name === 'raw html of many tags');
    if (!shape) throw new Error('shape');
    const state = await stateFromDocJson(shape.build(500_000));
    const { ms, last: result } = await leastCpu(() => convertInProcess(state));
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
    expect(ms, `cpu ms ${String(ms)}`).toBeLessThan(5_000); // about 400 ms CPU when idle; the defect it guards against is 100 s
  });

  it('30,000 hard breaks in one paragraph are refused; 1,000 convert', async () => {
    const shape = SHAPES.find((candidate) => candidate.name === 'hard breaks');
    if (!shape) throw new Error('shape');
    expect(await convertInProcess(await stateFromDocJson(shape.build(60_000)))).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await convertInProcess(await stateFromDocJson(shape.build(2_000)))).toMatchObject({ ok: true });
  });
});
