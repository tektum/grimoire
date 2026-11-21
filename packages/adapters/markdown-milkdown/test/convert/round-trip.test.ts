import { describe, expect, it } from 'vitest';
import { normaliseForMarkdown } from '@tektum/grimoire-editor-schema';
import { convertInProcess } from '../../src/index.js';
import { getHeadless } from '../../src/headless.js';
import { generateEditorDocument } from '../../src/testing/generate.js';
import { editorSweep, markdownSweep } from '../../src/testing/sweeps.js';
import {
  bulletListWith,
  codeBlockWith,
  emptyItemThen,
  paragraphWith,
  stateFromDocJson,
  stateFromFragment,
  stateFromMarkdownDirect,
} from '../../src/testing/states.js';

/**
 * The read-back check (guards.ts `compareDocuments`): the normal form of the document, `normaliseForMarkdown`, must equal
 * the document read back from the Markdown written for it: node types, attributes, marks and text. Exceptions, each a
 * named rule: the list `spread` flag; plain text that looks like an address read back as a link (1); second-save drift,
 * which is a difference in Markdown text only and never reaches the comparison (2); U+0000 and lone surrogates (3); the
 * marks of a space at the edge of a marked run (4). Every other difference is `content-lost`.
 */
const strict = (node: unknown): string =>
  JSON.stringify(node, (key, value: unknown) => {
    if (key === 'spread') return undefined;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value;
  });

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const para = (...content: unknown[]) => ({ type: 'paragraph', attrs: { level: 0 }, ...(content.length ? { content } : {}) });
const heading = (level: number, ...content: unknown[]) => ({ type: 'paragraph', attrs: { level }, content });
const text = (value: string, ...marks: string[]) => ({ type: 'text', text: value, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
const item = (checked: boolean | null, ...content: unknown[]) => ({
  type: 'list_item',
  attrs: { label: '\u2022', listType: 'bullet', spread: false, checked },
  content,
});
const bullets = (...items: unknown[]) => ({ type: 'bullet_list', attrs: { spread: false }, content: items });
const convert = async (json: unknown) => convertInProcess(await stateFromDocJson(json));
const reason = (r: Awaited<ReturnType<typeof convert>>) => (r.ok ? 'ok' : r.reason);

describe('accepted classes (each a named rule with its own test)', () => {
  it('1. address becomes link: plain text that looks like an address is accepted, text unchanged', async () => {
    for (const address of ['http://example.com/a', 'www.example.org', 'me@example.com']) {
      const result = await convert(doc(para(text(`see ${address} now`))));
      expect(result, address).toMatchObject({ ok: true });
      expect(result.ok && result.text).toBe(`see ${address} now`);
    }
  });

  it('1. is not widened: a real link (its target is not its own text) stays a link, written as a link, and is not treated as an address that became a link', async () => {
    // The rule only covers text that looks like an address and was read back as a link to itself. A link whose target differs from its text is not
    // that case: the writer and the reader agree on it, so it converts, and the Markdown keeps it as a link (a mark lost here would be content lost).
    const real = { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://example.com/d', title: null } }] };
    const result = await convert(doc(para(real)));
    expect(result.ok).toBe(true);
    expect(result.ok && result.markdown).toBe('[docs](https://example.com/d)\n');
  });

  it('2. second-save drift: Markdown text changes on the first save, the document does not', async () => {
    const input = 'Title\n=====\n\n- a\n- b\n\nhttps://example.com\n';
    const first = await convertInProcess(await stateFromMarkdownDirect(input));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await convertInProcess(await stateFromMarkdownDirect(first.markdown));
    expect(second.ok).toBe(true);
    // the bare URL gained angle brackets on the first save and the bullets became stars: stable from the second pass on
    const third = await convertInProcess(await stateFromMarkdownDirect(second.ok ? second.markdown : ''));
    expect(third.ok && second.ok && third.markdown === second.markdown).toBe(true);
    // What rule 2 promises: the Markdown text changed on the first save (otherwise this is not drift), and the document did not.
    expect(first.markdown).not.toBe(input);
    const headless = await getHeadless();
    const asDocument = (markdown: string): string => strict(normaliseForMarkdown(headless.parse(markdown)).toJSON());
    expect(asDocument(first.markdown)).toBe(asDocument(input));
  });

  it('3. NUL and a lone surrogate are replaced by the converter and by the reader alike: accepted', async () => {
    expect(reason(await convert(doc(para(text('a\u0000b \uD800 c')))))).toBe('ok');
  });

  it('4. a space at the edge of a marked run: accepted', async () => {
    const result = await convert(doc(para(text('bold', 'strong'), text(' x ', 'strong'), text('end'))));
    expect(result).toMatchObject({ ok: true });
  });

  it('4. is not widened here: a lone marked space between letters is saved plain by the normal form, not by the rule (see below)', async () => {
    expect(reason(await convert(doc(para(text('a'), text('b', 'inlineCode'), text('c')))))).toBe('ok');
  });

  it('5. the order of marks is not a difference', async () => {
    const a = await convert(doc(para(text('x', 'strong', 'emphasis'))));
    const b = await convert(doc(para(text('x', 'emphasis', 'strong'))));
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
  });
});

describe('whitespace-only marked runs: the normal form drops their marks, the comparison needs no rule', () => {
  // Found while narrowing rule 4: `normaliseForMarkdown` already removes link, strike-through and strong from a
  // run of one space between letters, so the page is saved as `a b` and the live document keeps the mark. Not a tolerance of
  // the converter: pinned here so a change of the schema's normal form is noticed.
  it.each(['link', 'strike_through', 'strong'])('a lone %s space between letters is saved as a plain space', async (type) => {
    const mark = type === 'link' ? { type, attrs: { href: 'http://u.example/x', title: null } } : { type };
    const result = await convert(doc(para(text('a'), { type: 'text', text: ' ', marks: [mark] }, text('b'))));
    expect(result).toMatchObject({ ok: true, markdown: 'a b\n', text: 'a b' });
  });
});

describe('inline code keeps its spaces', () => {
  // Code text is never trimmed: a lone code-marked space between letters is written as a code span
  // holding the space, and it reads back as the normal form (so the converter accepts it, no loss).
  it('a lone inlineCode space between letters is saved as a code span of one space', async () => {
    const result = await convert(doc(para(text('a'), { type: 'text', text: ' ', marks: [{ type: 'inlineCode' }] }, text('b'))));
    expect(result).toMatchObject({ ok: true, markdown: 'a` `b\n', text: 'a b' });
  });
});

describe('search text is the text of the normal form', () => {
  it('equals textBetween of normaliseForMarkdown(document) for 100 editor documents', async () => {
    const headless = await getHeadless();
    for (let i = 1; i <= 100; i += 1) {
      const json = generateEditorDocument(i);
      const result = await convert(json);
      if (!result.ok) continue;
      const normal = normaliseForMarkdown(headless.schema.nodeFromJSON(json));
      const expected = normal.textBetween(0, normal.content.size, '\n', (node) => (node.type.name === 'image' ? String(node.attrs['alt'] ?? '') : node.type.name === 'hardbreak' ? ' ' : ''));
      expect(result.text, `seed ${i}`).toBe(expected.replace(/\n{2,}/g, '\n').replace(/^\n|\n$/g, ''));
    }
  }, 60_000);
});

describe('listed losses of docs/proof/m2-schema-fixes.md: refused (content-lost), or covered by a named rule, one test each', () => {
  it('a task checkbox in front of a heading: refused', async () => {
    expect(reason(await convert(doc(bullets(item(true, heading(2, text('title')))))))).toBe('content-lost');
  });

  it('two runs with partly overlapping marks and a space between (emphasis+strong, then strong+link): refused', async () => {
    // the schema's canary: the space starts the strong+link run, so rule 4 may drop its marks, yet the marks of the letters differ
    const link = { type: 'text', text: ' t', marks: [{ type: 'strong' }, { type: 'link', attrs: { href: 'u', title: null } }] };
    expect(reason(await convert(doc(para(text('Z', 'emphasis', 'strong'), link))))).toBe('content-lost');
  });

  it('a newline character inside a text node (damaged Yjs content only): written as a line break in the paragraph, read back as the same text', async () => {
    expect(await convert(doc(para(text('one\ntwo'))))).toMatchObject({ ok: true, markdown: 'one\ntwo\n', text: 'one two' });
  });

  it('plain text that looks like an address: accepted by rule 1', async () => {
    expect(reason(await convert(doc(para(text('mail me@example.com')))))).toBe('ok');
  });

  it('a list written loose where it was tight (empty paragraph before a nested list): accepted, spread is not compared', async () => {
    expect(reason(await convert(doc(bullets(item(null, para(), bullets(item(null, para(text('b')))))))))).toBe('ok');
  });

  it('an empty heading at the end of the document: dropped by the normal form, so the page converts without it', async () => {
    const result = await convert(doc(para(text('a')), heading(2)));
    expect(result).toMatchObject({ ok: true, markdown: 'a\n', text: 'a' });
  });

  it('bullets written with a star, setext headings and bare URLs: second-save drift, accepted (rule 2)', async () => {
    const first = await convertInProcess(await stateFromMarkdownDirect('- a\n- b\n'));
    expect(first).toMatchObject({ ok: true, markdown: '* a\n* b\n' });
  });

  it('a link mark on an image atom is lost inside Yjs before the converter sees the page: not detectable (known limit, canary in known-limits.test.ts)', async () => {
    const image = { type: 'image', attrs: { src: 'i.png', alt: 'a', title: '', href: '', linkTitle: '' }, marks: [{ type: 'link', attrs: { href: 'http://u.example', title: null } }] };
    const result = await convert(doc(para(image)));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.markdown).not.toContain('u.example');
  });

  it('a refusal says where, with node types and counts only, never page text', async () => {
    const result = await convert(doc(bullets(item(true, heading(2, text('PRIVATE-TITLE'))))));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-TITLE');
  });
});

describe('what the schema fixed in part 4 now converts and reads back equal', () => {
  const hardbreak = { type: 'hardbreak', attrs: { isInline: false } };
  const exact = async (json: unknown): Promise<void> => {
    const headless = await getHeadless();
    const result = await convert(json);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const back = headless.parse(result.markdown);
    expect(strict(normaliseForMarkdown(headless.schema.nodeFromJSON(json)).toJSON())).toBe(strict(back.toJSON()));
  };

  it('a hard break inside a heading', async () => {
    await exact(doc(heading(2, text('a'), hardbreak, text('b'))));
  });

  it('a hard break inside a table cell', async () => {
    const cell = (type: string, ...content: unknown[]) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: null }, content: [para(...content)] });
    await exact(doc({ type: 'table', content: [{ type: 'table_header_row', content: [cell('table_header', text('a'), hardbreak, text('b')), cell('table_header', text('c'))] }, { type: 'table_row', content: [cell('table_cell', text('d')), cell('table_cell', text('e'))] }] }));
  });

  it('a list that does not start at 1, first in a quote after a paragraph', async () => {
    const list = { type: 'ordered_list', attrs: { order: 3, spread: false }, content: [{ type: 'list_item', attrs: { label: '3.', listType: 'ordered', spread: false, checked: null }, content: [para(text('x'))] }] };
    await exact(doc(bullets(item(null, para(text('a')), { type: 'blockquote', content: [list] }))));
  });

  it('inline code with emphasis, then a letter', async () => {
    await exact(doc(para(text('x', 'emphasis', 'inlineCode'), text('two'))));
  });

  it('a link between emphasised and strong runs', async () => {
    const link = { type: 'text', text: 'b', marks: [{ type: 'emphasis' }, { type: 'link', attrs: { href: 'u', title: null } }] };
    await exact(doc(para(text('a', 'emphasis', 'strong'), link, text('c', 'strong'))));
  });
});

describe('normalised before comparing and writing: Markdown and search text describe the same document', () => {
  it('a trailing hard break is dropped from the Markdown and from the search text', async () => {
    const state = stateFromFragment((fragment, doc2) => {
      doc2.transact(() => {
        const first = paragraphWith('text');
        fragment.insert(0, [first]);
        first.insert(1, [new (paragraphWith('').constructor as new (name: string) => ReturnType<typeof paragraphWith>)('hardbreak')]);
      });
    });
    const result = await convertInProcess(state);
    expect(result).toMatchObject({ ok: true, markdown: 'text\n', text: 'text' });
  });

  it('trailing spaces and empty last paragraphs are not in the Markdown and not in the search text', async () => {
    const result = await convert(doc(para(text('word  ')), para(), para()));
    expect(result).toMatchObject({ ok: true, markdown: 'word\n', text: 'word' });
  });
});

describe('emptied list items are written loose and read back', () => {
  it.each([
    ['a code block', () => codeBlockWith('x = 1')],
    ['a nested list', () => bulletListWith('sub')],
    ['a paragraph', () => paragraphWith('after')],
  ])('an emptied list item followed by %s converts', async (_name, second) => {
    const result = await convertInProcess(emptyItemThen(second));
    expect(result).toMatchObject({ ok: true });
  });
});

describe('properties over seeded documents', () => {
  // A smaller sweep here (bun run test shares one machine with every other package); the full sizes, 2,000 and 2,000, run in
  // test/benchmark/sweep.test.ts. Same code: src/testing/sweeps.ts.
  it('documents read from Markdown (150 seeds, i*7919): all convert, none refused', async () => {
    expect(await markdownSweep(150)).toEqual([]);
  }, 120_000);

  it('editor documents (300 seeds): accepted ones are one read-back from an exact fixed point, refusals are listed classes', async () => {
    const { problems, counts } = await editorSweep(300);
    expect(problems).toEqual([]);
    expect(counts.ok).toBeGreaterThan(200);
    expect(counts.refused).toBeGreaterThan(10);
    expect(counts.addressReadBack).toBeLessThan(10);
  }, 200_000);
});
