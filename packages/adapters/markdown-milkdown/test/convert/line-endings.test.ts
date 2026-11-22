import { describe, expect, it } from 'vitest';
import { convertInProcess } from '../../src/index.js';
import { stateFromDocJson } from '../../src/testing/states.js';

// Review finding F6: one carriage return in a paragraph made the conversion fail closed ("1 children became 3") and the
// page never got fresh Markdown. Texts made of letters and every line-ending-like character, in every container.
const PIECES = ['a', 'b', 'xy', ' ', '\r', '\r\n', '\n', '\u2028', '\u2029', '\u0085', '\u000b', '\u000c', '\t'];

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
/** The letters of the input, in order: every piece of the text is kept (the search text holds no link address; the table header `h` is not in the set). */
const lettersOf = (value: string): string => value.replace(/[^abxy]/g, '');
function textOf(seed: number): string {
  const next = rng(seed * 2654435761);
  let out = '';
  for (let i = 0, n = 1 + Math.floor(next() * 7); i < n; i += 1) out += PIECES[Math.floor(next() * PIECES.length)] as string;
  // Never only whitespace: a paragraph of spaces is a different, accepted case.
  return `a${out}b`;
}

type Json = Record<string, unknown>;
const para = (level: number, ...content: Json[]): Json => ({ type: 'paragraph', attrs: { level }, content });
const run = (text: string, ...marks: string[]): Json => ({ type: 'text', text, ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}) });
const cell = (type: string, text: string): Json => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: null }, content: [para(0, run(text))] });
const containers: [string, (text: string) => Json][] = [
  ['paragraph', (text) => para(0, run(text))],
  ['heading', (text) => para(2, run(text))],
  ['emphasised text', (text) => para(0, run(text, 'emphasis'))],
  ['link text', (text) => para(0, { type: 'text', text, marks: [{ type: 'link', attrs: { href: 'https://example.com/', title: null } }] })],
  ['table cell', (text) => ({ type: 'table', content: [{ type: 'table_header_row', content: [cell('table_header', 'h')] }, { type: 'table_row', content: [cell('table_cell', text)] }] })],
  ['list item', (text) => ({ type: 'bullet_list', attrs: { spread: false }, content: [{ type: 'list_item', attrs: { label: '\u2022', listType: 'bullet', spread: false, checked: null }, content: [para(0, run(text))] }] })],
  ['code block', (text) => ({ type: 'code_block', attrs: { language: '' }, content: [{ type: 'text', text }] })],
  ['inline code', (text) => para(0, run(text, 'inlineCode'))],
];

describe('line endings and their look-alikes in text: every container converts, and reads back as the normal form', () => {
  it.each(containers)('%s: 300 seeded texts of CR, CRLF, LF, U+2028, U+2029, U+0085, VT, FF, tab, letters', async (name, build) => {
    const refused: string[] = [];
    const wrong: string[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      const text = textOf(seed);
      const result = await convertInProcess(await stateFromDocJson({ type: 'doc', content: [build(text)] }));
      if (!result.ok) refused.push(`${JSON.stringify(text)}: ${result.reason} ${result.detail}`);
      // A success must also be right: the text is there, written without carriage returns, and found by the search text.
      else if (result.markdown.length === 0 || result.markdown.includes('\r') || lettersOf(result.text) !== lettersOf(text)) {
        wrong.push(`${JSON.stringify(text)}: ${JSON.stringify(result.markdown)} / ${JSON.stringify(result.text)}`);
      }
    }
    expect(refused.slice(0, 5)).toEqual([]);
    expect(wrong.slice(0, 5)).toEqual([]);
  }, 120_000);

  it('the minimal case: a lone CR in a paragraph', async () => {
    const result = await convertInProcess(await stateFromDocJson({ type: 'doc', content: [para(0, run('a\rb'))] }));
    expect(result).toMatchObject({ ok: true, markdown: 'a\nb\n', text: 'a b' });
  });

  it('CRLF is one line break, not two', async () => {
    const result = await convertInProcess(await stateFromDocJson({ type: 'doc', content: [para(0, run('a\r\nb'))] }));
    expect(result).toMatchObject({ ok: true, markdown: 'a\nb\n' });
  });
});
