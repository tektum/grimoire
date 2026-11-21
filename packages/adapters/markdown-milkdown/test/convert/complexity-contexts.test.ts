import { describe, expect, it } from 'vitest';
import { complexityOf, MAX_CHILDREN, markdownComplexityProblem, tooManyChildren, type Branching } from '../../src/guards.js';

// The guard is SOUND before it is precise: it charges every character of every line in a run of non-blank lines, whatever container the line is in, so it
// may refuse a document the reader could parse, and it must never accept one the reader cannot. These tests are the hostile inputs of every review round
// (all refused), the documented known limits (valid but dense documents refused), a soundness property, and the linear-time check.
const stars = (n: number): string => '*'.repeat(n);
const lines = (count: number, make: (i: number) => string): string => Array.from({ length: count }, (_, i) => make(i)).join('\n');
const refused = (markdown: string): void => { expect(markdownComplexityProblem(markdown)).toBeDefined(); };
const accepted = (markdown: string): void => { expect(markdownComplexityProblem(markdown)).toBeUndefined(); };

describe('hostile inputs, by review round: all refused', () => {
  it('round 1: pages of delimiters split by lines that only look like a heading, a table row or a fence', () => {
    refused(lines(5, () => `#${stars(9000)}`));
    refused(lines(5, () => `#######${stars(9000)}`));
    refused(lines(5, () => `| ${stars(9000)} | x |`));
    refused(['> ```', '> code', stars(20_000)].join('\n'));
    refused(['> ```', '> code', '', stars(20_000)].join('\n'));
  });

  it('round 2: ordered items that do not start a list, indented fences, a fence closed at another depth', () => {
    refused(['text', ...Array.from({ length: 4 }, () => `2. ${stars(9000)}`)].join('\n'));
    refused(['paragraph', '    ```', `    ${stars(20_000)}`].join('\n'));
    refused(['- a', '', 'paragraph', '    ```', `    ${stars(20_000)}`].join('\n'));
    refused(['```', '> ```', stars(20_000), '```'].join('\n'));
  });

  it('round 3: indented headings and list markers, a list ended by a heading or a fence, many contexts together', () => {
    refused(['paragraph', ...Array.from({ length: 4 }, () => `    # ${stars(9000)}`)].join('\n'));
    refused(['paragraph', ...Array.from({ length: 4 }, () => `    - ${stars(9000)}`)].join('\n'));
    refused(['- a', '# H', 'text', '    ```', `    ${stars(20_000)}`].join('\n'));
    refused(['- a', '```', 'code', '```', 'text', '    ```', `    ${stars(20_000)}`].join('\n'));
    refused(['- x', ...Array.from({ length: 4 }, () => `  2. ${stars(9000)}`)].join('\n'));
    refused(lines(60, () => `# ${stars(9000)}`));
  });

  it('round 4: CR and CRLF line ends, paragraphs charged before a fence or a delimiter row, a table shape, a quote that ends a list', () => {
    refused(`~~~\r~~~\r${']'.repeat(30_000)}`);
    refused(`~~~\r\n~~~\r\n${']'.repeat(30_000)}`);
    refused(lines(50, () => `${'*a'.repeat(4000)}\n\`\`\`\n\`\`\``));
    refused(['| a | b |', '| - |', ...Array.from({ length: 5 }, () => `x${'*a'.repeat(2500)}`)].join('\n'));
    refused(['- a', '> quote', '    ```', `    ${stars(20_000)}`].join('\n'));
  });

  it('round 5: escaped pipes, a fence that ends a table, a header line before a fence', () => {
    refused(['a | b | c', '- | -', ...Array.from({ length: 5 }, () => `${stars(5000)} | x`)].join('\n'));
    refused(['| a |', '| - |', '| x |', '```', 'code', '```', ...Array.from({ length: 4 }, () => `| ${stars(4500)}`)].join('\n'));
    refused(['| a | b |', '```', '```', '| - | - |', ...Array.from({ length: 4 }, () => `| ${stars(4500)}`)].join('\n'));
  });

  it('round 6: a heading or a quoted line as a table header, indented code that continues a paragraph', () => {
    const rows = Array.from({ length: 4 }, () => `| ${stars(4500)}`);
    refused(['# a | b', '| - | - |', ...rows].join('\n'));
    refused(['> a | b', '| - | - |', ...rows].join('\n'));
    refused(['text', ...Array.from({ length: 5 }, () => `    ${stars(9000)}`)].join('\n'));
    refused(['- item', ...Array.from({ length: 5 }, () => `    ${stars(9000)}`)].join('\n'));
  });

  it('round 7: spaces and markers before a quoted paragraph read as code indentation', () => {
    refused(`   > ${stars(12_000)}`);
    refused(`> > > > ${stars(12_000)}`);
    refused(`>    ${stars(12_000)}`);
  });

  it('wrapped in any container, the same text is still refused', () => {
    const body = stars(12_000);
    for (const wrapped of [`> ${body}`, `- ${body}`, `    ${body}`, `\`\`\`\n${body}\n\`\`\``, `| ${body} |`, `# ${body}`, `1. ${body}`, `>> - > ${body}`]) refused(wrapped);
  });
});

describe('documented known limits: valid but dense documents are refused (the guard over-counts on purpose)', () => {
  it('a code block, a table or a run of headings with an extreme density of delimiter characters is refused, naming the budget', () => {
    expect(markdownComplexityProblem(['```', ...Array.from({ length: 20 }, () => stars(1000)), '```'].join('\n'))).toMatch(/more than 10000 delimiters/);
    refused(lines(5, () => `# ${stars(5000)}`)); // headings are charged as one run of lines
    refused(['| a | b |', '| - | - |', ...Array.from({ length: 5 }, () => `| ${stars(5000)} | x |`)].join('\n'));
    refused(['> ```', `> ${stars(20_000)}`, '> ```'].join('\n'));
    refused(lines(5, (i) => `${i + 1}. ${stars(5000)}`));
  });
  it('many runs that are each under the budget are refused together by the document-wide budget', () => {
    expect(markdownComplexityProblem(Array.from({ length: 5 }, () => stars(9000)).join('\n\n'))).toMatch(/document-wide budget/);
    expect(markdownComplexityProblem(Array.from({ length: 4 }, () => stars(9000)).join('\n\n'))).toBeUndefined();
  });
  it('the same content separated by blank lines is accepted: a paragraph never continues over a blank line', () => {
    accepted(Array.from({ length: 5 }, () => `# ${stars(5000)}`).join('\n\n'));
    accepted(Array.from({ length: 20 }, () => stars(1000)).join('\n\n'));
  });
});

describe('soundness: wrapping content in a container never decreases what the guard charges', () => {
  const pieces = ['*a', '_x', '[l](u)', '`c`', '~~s~~', '\\*', '\\[', 'text', '| a | b |', '| - | - |', '# h', '- i', '1. n', '    code', '> q', '```', '', '   ', ' '];
  const seeded = (seed: number): (() => number) => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32; };
  const wrappers: [string, (lineText: string, index: number) => string][] = [
    ['quote', (l) => (l.trim() === '' ? '>' : `> ${l}`)],
    ['nested quote', (l) => `>> > ${l}`],
    ['list item', (l, i) => (i === 0 ? `- ${l}` : `  ${l}`)],
    ['indented code', (l) => `    ${l}`],
    ['table row', (l) => `| ${l} |`],
    ['heading', (l) => `# ${l}`],
    ['ordered item', (l, i) => (i === 0 ? `7. ${l}` : `   ${l}`)],
    ['tab', (l) => `\t${l}`],
  ];
  it('for 300 generated documents and every wrapper: the largest run, its escaped total and the cost never go down', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = seeded(seed * 2654435761);
      const content = Array.from({ length: 1 + Math.floor(next() * 12) }, () => pieces[Math.floor(next() * pieces.length)] as string);
      const before = complexityOf(content.join('\n'));
      const candidates: [string, string][] = wrappers.map(([name, wrap]) => [name, content.map(wrap).join('\n')]);
      candidates.push(['fence', ['```', ...content, '```'].join('\n')], ['crlf', content.join('\r\n')], ['cr', content.join('\r')]);
      for (const [name, text] of candidates) {
        const after = complexityOf(text);
        const where = `seed ${seed} ${name}`;
        expect(after.maxUnescaped, where).toBeGreaterThanOrEqual(before.maxUnescaped);
        expect(after.maxTotal, where).toBeGreaterThanOrEqual(before.maxTotal);
        expect(after.cost, where).toBeGreaterThanOrEqual(before.cost);
      }
    }
  });
});

describe('calibration: real documents are far below the budgets', () => {
  it('prose, lists, tables and code of ordinary size are accepted with a wide margin', () => {
    accepted(Array.from({ length: 300 }, (_, i) => `Paragraph ${i} with *emphasis*, \`code\`, [a link](https://example.com/${i}) and snake_case_words.`).join('\n\n'));
    accepted(lines(1000, (i) => `- item ${i} with **bold** and [link](u)`)); // 6,000 delimiters in one run: below the 10,000 budget
  });
});

describe('long lines are checked in linear time', () => {
  // A backtracking pattern takes seconds on these lines, every time; the fastest of five attempts is compared with the limit so that a busy machine cannot fail the test.
  const shapes: [string, string][] = [
    ['dashes then a letter', `| ${'-'.repeat(400_000)}x`],
    ['spaced dashes', `|${' -'.repeat(200_000)}x`],
    ['pipes and dashes', `${'|-'.repeat(200_000)}x`],
    ['spaces', `|${' '.repeat(400_000)}x`],
    ['backslashes', `|${'\\-'.repeat(200_000)}x`],
    ['stars', stars(400_000)],
  ];
  it.each(shapes)('%s: a line of 400,000 characters is charged in under 50 ms', (_name, line) => {
    const markdown = `| a |\n${line}\n`;
    const took: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const t0 = performance.now();
      markdownComplexityProblem(markdown);
      took.push(performance.now() - t0);
    }
    expect(Math.min(...took)).toBeLessThan(50);
  });
});

describe('the child and block limits at their boundary', () => {
  const node = (childCount: number, inner: ReturnType<typeof node>[] = []): Branching => ({
    childCount,
    descendants: (visit) => { for (const child of inner) { if (visit(child) === false) return; child.descendants(visit); } },
  });
  it('a block of exactly the limit is accepted, one more is refused, anywhere in the tree', () => {
    expect(tooManyChildren(node(2, [node(MAX_CHILDREN)]), 10)).toBeUndefined();
    expect(tooManyChildren(node(2, [node(MAX_CHILDREN + 1)]), 10)).toMatch(/more than 25000 children/);
    expect(tooManyChildren(node(1, [node(1, [node(MAX_CHILDREN + 1)])]), 10)).toBeDefined();
  });
  it('the document itself holds exactly maxBlocks blocks, not one more', () => {
    expect(tooManyChildren(node(10), 10)).toBeUndefined();
    expect(tooManyChildren(node(11), 10)).toMatch(/more than 10 blocks/);
  });
});

