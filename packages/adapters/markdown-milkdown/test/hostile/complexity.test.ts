import { describe, expect, it } from 'vitest';
import { markdownComplexityProblem } from '../../src/guards.js';
import { convertInProcess, seedInProcess } from '../../src/index.js';
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

describe('Markdown complexity pre-check (the Markdown parser is quadratic in the delimiters of one paragraph)', () => {
  it('refuses 30,000 unescaped closing brackets in one paragraph before parsing (the parser takes about 40 s on them)', async () => {
    const markdown = ']'.repeat(30_000);
    expect(markdownComplexityProblem(markdown)).toMatch(/delimiters/);
    const { ms, last: result } = await leastCpu(() => seedInProcess(markdown));
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
    expect(ms).toBeLessThan(1_000);
  });

  it.each([
    ['unmatched emphasis', '*a'.repeat(30_000)],
    ['alternating strong', '**a**a'.repeat(10_000)],
    ['strike-through', '~~a'.repeat(20_000)],
    ['underscores', '_a'.repeat(30_000)],
    ['backtick pairs', '`a'.repeat(30_000)],
  ])('refuses %s over the cap', (_name, markdown) => {
    expect(markdownComplexityProblem(markdown)).toMatch(/delimiters/);
  });

  it('counts escaped delimiters too, against a larger cap', () => {
    const escaped = '\\[';
    expect(markdownComplexityProblem(escaped.repeat(120_000))).toMatch(/delimiters/);
    expect(markdownComplexityProblem(escaped.repeat(40_000))).toBeUndefined();
  });

  it('ordinary documents are accepted; a run of lines is charged as one (documented known limits below)', () => {
    // A tight list of 1,000 items, each with emphasis and a link: 5,000 delimiters in one run of lines, under the budget of 10,000.
    expect(markdownComplexityProblem(Array.from({ length: 1000 }, (_, i) => `- *item ${i}* and **bold** and [link](https://x.y/${i})`).join('\n'))).toBeUndefined();
    // Blank lines end a run: many paragraphs, quote paragraphs and list items are separate runs, whatever their number.
    expect(markdownComplexityProblem(Array.from({ length: 30_000 }, () => '*a* **b** `c`').join('\n\n'))).toBeUndefined();
    expect(markdownComplexityProblem(Array.from({ length: 20_000 }, () => '> *x* **y**').join('\n>\n'))).toBeDefined(); // a lone ">" is not a blank line: one run (known limit)
    expect(markdownComplexityProblem(Array.from({ length: 20_000 }, () => '> *x* **y**').join('\n\n'))).toBeUndefined();
    // Known limits (the guard over-counts on purpose, see its comment): code, tables and very long tight lists are charged like prose.
    expect(markdownComplexityProblem(`\`\`\`\n${'*'.repeat(200_000)}\n\`\`\`\n`)).toMatch(/delimiters/);
    expect(markdownComplexityProblem(['| a | b |', '| - | - |', ...Array.from({ length: 20_000 }, () => '| *x* | **y** |')].join('\n'))).toMatch(/delimiters/);
    expect(markdownComplexityProblem(Array.from({ length: 20_000 }, (_, i) => `- *item ${i}* and **bold** and [link](https://x.y/${i})`).join('\n'))).toMatch(/delimiters/);
  });

  it('fences are not special: the same text is charged inside and outside them', () => {
    expect(markdownComplexityProblem(`\`\`\`\n${'*'.repeat(50_000)}\n~~~\n${'*'.repeat(50_000)}\n\`\`\`\n`)).toMatch(/delimiters/);
    expect(markdownComplexityProblem(`\`\`\`\nx\n\`\`\`\n${'*a'.repeat(30_000)}\n`)).toMatch(/delimiters/);
  });
});

describe('a block with a huge number of children is refused before the serializer (it copies the child list once per child)', () => {
  it('one raw html node of 62,500 whole elements splits into 187,500 children: refused in a few seconds of CPU at most (400 ms idle), not 100 s', async () => {
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
