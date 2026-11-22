import { describe, expect, it } from 'vitest';
import { MAX_CHILDREN, seedMarkdownProblem, tooManyChildren } from '../../src/guards.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { reseedInProcess, seedInProcess } from '../../src/seed.js';

const L = DEFAULT_LIMITS;
const problem = (md: string) => seedMarkdownProblem(md, L);

describe('the seed pre-check: three cheap limits, nothing else', () => {
  it('defaults: 192 KiB, 8,000 lines, 50 markers per line', () => {
    expect(L).toMatchObject({ maxSeedMarkdownBytes: 196_608, maxSeedLines: 8_000, maxSeedLineMarkers: 50 });
  });

  it('size: counted in bytes, the message names the limit and both values', () => {
    expect(problem('x'.repeat(196_608))).toBeUndefined();
    expect(problem('x'.repeat(196_609))).toEqual({ limit: 'bytes', message: 'the Markdown is 196609 bytes; the limit is 196608 bytes' });
    expect(seedMarkdownProblem('\u00e9'.repeat(51), { ...L, maxSeedMarkdownBytes: 100 })?.limit).toBe('bytes');
  });

  it('lines: LF, CRLF and a lone CR each end a line', () => {
    expect(problem('a\n'.repeat(7_999) + 'a')).toBeUndefined();
    expect(problem('a\n'.repeat(8_000) + 'a')).toEqual({ limit: 'lines', message: 'the Markdown has 8001 lines; the limit is 8000 lines' });
    expect(problem('a\r\n'.repeat(8_000) + 'a')?.limit).toBe('lines');
    expect(problem('a\r'.repeat(8_000) + 'a')?.limit).toBe('lines');
    expect(problem('a\r\n'.repeat(7_999) + 'a')).toBeUndefined();
  });

  it('markers: quote markers and list markers in the line prefix, 50 allowed, the message names the line', () => {
    expect(problem('>'.repeat(50) + ' x')).toBeUndefined();
    expect(problem('ok\n' + '>'.repeat(51) + ' x')).toEqual({ limit: 'markers', message: 'line 2 has 51 quote or list markers; the limit is 50 per line' });
    expect(problem('> - '.repeat(25) + 'x')).toBeUndefined();
    expect(problem('> - '.repeat(26) + 'x')?.limit).toBe('markers');
    expect(problem('1. '.repeat(51) + 'x')?.limit).toBe('markers');
    expect(problem(' >-'.repeat(12_000))?.limit).toBe('markers');
    expect(problem('- >'.repeat(8_000))?.limit).toBe('markers');
  });

  it('markers: rules, emphasis, tables and text after the prefix are not markers', () => {
    expect(problem('-'.repeat(200))).toBeUndefined();
    expect(problem('*'.repeat(200))).toBeUndefined();
    expect(problem('|---|---|' + '|'.repeat(100))).toBeUndefined();
    expect(problem('text ' + '> '.repeat(100))).toBeUndefined();
    expect(problem('- '.repeat(51))?.limit).toBe('markers');
  });

  it('markers: every kind of marker counts once, exactly at the limit', () => {
    for (const unit of ['>', '> ', '>\t', '- ', '+ ', '* ', '-\t', '1. ', '10. ', '1) ', '99999) ', '- >', '1. >']) {
      const per = unit.trim().length === 0 ? 1 : (unit.match(/>|[-+*]|\d+[.)]/g) ?? []).length;
      const n = Math.floor(50 / per);
      expect(problem(unit.repeat(n) + 'x'), unit).toBeUndefined();
      expect(problem(unit.repeat(n + 1) + 'x')?.limit, unit).toBe(n * per + per > 50 ? 'markers' : undefined);
    }
    expect(problem('-'.repeat(1) + ' ' + '> '.repeat(49))).toBeUndefined();
    expect(problem('- ' + '> '.repeat(50))?.limit).toBe('markers');
  });

  it('markers: a marker at the end of the line or of the text counts; the same characters inside a word or number do not', () => {
    for (const end of ['-', '-\n', '-\r\nx', '-\rx', '1.', '1.\n', '1)\n', '+', '*']) {
      expect(problem('> '.repeat(49) + end), end).toBeUndefined();
      expect(problem('> '.repeat(50) + end)?.limit, end).toBe('markers');
    }
    expect(problem('> '.repeat(50) + '- ')?.limit).toBe('markers');
    expect(problem('> '.repeat(50) + '1.5 text')).toBeUndefined();
    expect(problem('> '.repeat(50) + '-a')).toBeUndefined();
    expect(problem('> '.repeat(50) + '12 x')).toBeUndefined();
    expect(problem('> '.repeat(50) + '1.x')).toBeUndefined();
    expect(problem('> '.repeat(50) + '- x')?.limit).toBe('markers');
    expect(problem('> '.repeat(50) + '1. x')?.limit).toBe('markers');
    expect(problem('> '.repeat(50) + '12) x')?.limit).toBe('markers');
    expect(problem('> '.repeat(50) + '0. ')?.limit).toBe('markers');
    expect(problem('> '.repeat(50) + '9) ')?.limit).toBe('markers');
    expect(problem(' '.repeat(300) + 'x')).toBeUndefined();
    expect(problem('\t'.repeat(300) + '> x')).toBeUndefined();
  });

  it('markers: the message names the line, whatever ends the lines before it', () => {
    const bad = '>'.repeat(51);
    expect(problem(`a\nb\n${bad}`)?.message).toContain('line 3 has 51');
    expect(problem(`a\r\nb\r\n${bad}`)?.message).toContain('line 3 has 51');
    expect(problem(`a\rb\r${bad}`)?.message).toContain('line 3 has 51');
    expect(problem(`${bad}\n${bad}`)?.message).toContain('line 1 has 51');
    expect(problem(`ok\n${'>'.repeat(50)}\n${bad}`)?.message).toContain('line 3 has 51');
  });

  it('lines: a final line break does not add a line; an empty text is fine', () => {
    expect(problem('a\n'.repeat(8_000))).toBeUndefined();
    expect(problem('a\r\n'.repeat(8_000))).toBeUndefined();
    expect(problem('a\n'.repeat(8_001))?.limit).toBe('lines');
    expect(problem('\n'.repeat(8_000))).toBeUndefined();
    expect(problem('\n'.repeat(8_001))?.limit).toBe('lines');
    expect(problem('')).toBeUndefined();
    expect(seedMarkdownProblem('a\nb\nc', { ...L, maxSeedLines: 2 })?.limit).toBe('lines');
    expect(seedMarkdownProblem('a\nb', { ...L, maxSeedLines: 2 })).toBeUndefined();
    expect(seedMarkdownProblem('a\nb', { ...L, maxSeedLineMarkers: 1 })).toBeUndefined();
    expect(seedMarkdownProblem('> > x', { ...L, maxSeedLineMarkers: 1 })?.limit).toBe('markers');
    expect(seedMarkdownProblem('> x', { ...L, maxSeedLineMarkers: 1 })).toBeUndefined();
    expect(seedMarkdownProblem('aaa', { ...L, maxSeedMarkdownBytes: 3 })).toBeUndefined();
    expect(seedMarkdownProblem('aaaa', { ...L, maxSeedMarkdownBytes: 3 })?.limit).toBe('bytes');
  });

  it('the old delimiter budgets are gone: delimiter-heavy but ordinary text is accepted', () => {
    expect(problem('*a_'.repeat(30_000))).toBeUndefined();
    expect(problem(']'.repeat(100_000))).toBeUndefined();
  });

  it('is linear: 192 KiB of the worst line shapes is checked in well under a second of CPU', () => {
    const t = process.cpuUsage();
    for (const md of ['>'.repeat(196_608), ' >-'.repeat(87_000), 'a\n'.repeat(130_000), '- '.repeat(130_000)]) problem(md);
    const used = process.cpuUsage(t);
    expect((used.user + used.system) / 1000).toBeLessThan(1_000);
  });
});

describe('inputs of the earlier reviews end in a named pre-check refusal', () => {
  const refused: [string, string, string][] = [
    ['nested quote and list markers, 36 KB', ' >-'.repeat(12_000), 'markers'],
    ['list and quote markers, 24 KB', '- >'.repeat(8_000), 'markers'],
    ['budget-edge mixture, 80 KB', ']a&1\n-&!'.repeat(10_000), 'lines'],
    ['block-dense text, 180 KB', '&1\n-&'.repeat(36_000), 'lines'],
    ['one over the size cap', 'a'.repeat(196_609), 'bytes'],
  ];
  it.each(refused)('%s', async (_name, md, limit) => {
    expect(problem(md)?.limit).toBe(limit);
    const r = await seedInProcess(md);
    expect(r).toMatchObject({ ok: false, reason: 'too-large', detail: problem(md)?.message });
  });
});

describe('shapes the old guard refused are accepted and converted', () => {
  const shapes: [string, string][] = [
    ['python listing, snake_case', '```python\n' + 'def foo_bar_baz(a_b, c_d):\n    return a_b * c_d_e\n'.repeat(2_000) + '```\n'],
    ['code with * and []', '```c\n' + 'for (i = 0; i < n; i++) { *p++ = a[i] * b[i]; }\n'.repeat(1_700) + '```\n'],
    ['pretty JSON', '```json\n' + '  {"a_b": [1, 2, {"c": "d_e"}], "f": "*g*"},\n'.repeat(2_500) + '```\n'],
    ['GFM task list', '- [ ] task *a* done_x\n'.repeat(5_100)],
    ['link table, 6 links a row', '| h | h | h | h | h | h |\n|---|---|---|---|---|---|\n' + '| [a](http://x.y/1) | [b](u) | [c](u) | [d](u) | [e](u) | [f](u) |\n'.repeat(900)],
    ['numbered references', Array.from({ length: 5_000 }, (_, i) => `See [${i}] text`).join('\n')],
    ['bold and italic lines', '- **bold** and _italic_ words\n'.repeat(1_700)],
  ];
  it.each(shapes)('%s', async (_name, md) => {
    expect(problem(md)).toBeUndefined();
    expect((await seedInProcess(md)).ok).toBe(true);
  }, 60_000);

  it('a seeded document that is nested deeper than the converter accepts is refused as too large, naming the seeded document', async () => {
    // Under the pre-check (one line, 5 markers) but over a depth limit of 3: the output guard on the seeded state is the second line of defence.
    const r = await seedInProcess('> > > > > deep', { maxDepth: 3 });
    expect(r).toMatchObject({ ok: false, reason: 'too-large' });
    expect(JSON.stringify(r)).toMatch(/seeded document/);
  });

  it('a code block is never described as a paragraph', async () => {
    const r = await seedInProcess('```\n' + 'a\n'.repeat(8_001) + '```\n');
    expect(r).toMatchObject({ ok: false, reason: 'too-large' });
    expect(JSON.stringify(r)).not.toMatch(/paragraph|delimiter/);
  });
});

describe('the system rebuild (reseed) has its own limits; the user seed cannot reach them', () => {
  const lines = (n: number): string => 'a\n\n'.repeat(n);
  it('accepts what the user seed refuses: more than 8,000 lines, up to 1 MiB, 100 markers on a line', async () => {
    expect((await seedInProcess(lines(5_000)))).toMatchObject({ ok: false, reason: 'too-large' });
    expect((await reseedInProcess(lines(5_000))).ok).toBe(true);
    expect((await seedInProcess('x'.repeat(200_000)))).toMatchObject({ ok: false, reason: 'too-large' });
    expect((await reseedInProcess('x'.repeat(1_048_576))).ok).toBe(true);
    expect((await seedInProcess('>'.repeat(60) + ' x'))).toMatchObject({ ok: false, reason: 'too-large' });
    expect((await reseedInProcess('>'.repeat(100) + ' x', { maxDepth: 1_000 })).ok).toBe(true);
  }, 60_000);
  it('still has limits: 1 MiB plus one byte, 101 markers', async () => {
    expect(await reseedInProcess('x'.repeat(1_048_577))).toEqual({ ok: false, reason: 'too-large', detail: 'the Markdown is 1048577 bytes; the limit is 1048576 bytes' });
    expect(await reseedInProcess('>'.repeat(101) + ' x')).toEqual({ ok: false, reason: 'too-large', detail: 'line 1 has 101 quote or list markers; the limit is 100 per line' });
  });
  it('the user seed ignores the lenient limits whatever the caller passes', async () => {
    const lenient = { maxReseedMarkdownBytes: 1 << 30, maxReseedLineMarkers: 1 << 20 };
    expect(await seedInProcess('x'.repeat(196_609), lenient)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await seedInProcess('>'.repeat(51) + ' x', lenient)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await seedInProcess(lines(4_001), lenient)).toMatchObject({ ok: false, reason: 'too-large' });
  });
});

describe('the block-count guard on a seeded document', () => {
  const doc = (childCount: number, children: number[] = []): Parameters<typeof tooManyChildren>[0] => ({
    childCount,
    descendants: (visit) => { for (const c of children) visit({ childCount: c, descendants: () => undefined }); },
  });
  it('refuses a document with more top-level blocks than the limit, naming the limit', () => {
    expect(tooManyChildren(doc(5), 4)).toBe('the document has more than 4 blocks');
    expect(tooManyChildren(doc(4), 4)).toBeUndefined();
  });
  it('refuses a block with more children than the converter can read back, and accepts one at the limit', () => {
    expect(tooManyChildren(doc(1, [MAX_CHILDREN + 1]), 10)).toBe(`a block has more than ${MAX_CHILDREN} children`);
    expect(tooManyChildren(doc(1, [MAX_CHILDREN]), 10)).toBeUndefined();
  });
});
