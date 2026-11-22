/** Adversarial documents (ProseMirror JSON) of the shapes the review found or suspected to be expensive. `size` is a count of characters or runs. */
type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; marks?: { type: string; attrs?: Record<string, unknown> }[]; text?: string };

const paragraph = (...content: Json[]): Json => ({ type: 'paragraph', attrs: { level: 0 }, content });
const text = (value: string, ...marks: string[]): Json => ({ type: 'text', text: value, ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}) });
const doc = (...blocks: Json[]): Json => ({ type: 'doc', content: blocks });

export interface Shape {
  name: string;
  /** What `size` counts. */
  unit: 'characters' | 'runs';
  build(size: number): Json;
}

// "a", a long run of blanks, then "x " inside a mark: the trailing-space scan runs on a value that ends in a space (review follow-up).
const markedGap = (mark: Json, blank: string): ((n: number) => Json) => (n) => doc(paragraph(text('p '), { type: 'text', text: `a${blank.repeat(n)}x `, marks: [mark] }, text('q')));
const MARKS: Array<[string, Json]> = [
  ['emphasis', { type: 'emphasis' }],
  ['strong', { type: 'strong' }],
  ['strike-through', { type: 'strike_through' }],
  ['a link text', { type: 'link', attrs: { href: 'https://example.com/', title: null } }],
];
const gapShapes: Shape[] = MARKS.flatMap(([label, mark]): Shape[] => [
  { name: `spaces then "x " inside ${label}`, unit: 'characters', build: markedGap(mark, ' ') },
  { name: `tabs then "x " inside ${label}`, unit: 'characters', build: markedGap(mark, '\t') },
]);

export const SHAPES: Shape[] = [
  { name: 'spaces between letters', unit: 'characters', build: (n) => doc(paragraph(text(`a${' '.repeat(n)}x`))) },
  { name: 'tabs between letters', unit: 'characters', build: (n) => doc(paragraph(text(`a${'\t'.repeat(n)}x`))) },
  { name: 'mixed spaces and tabs', unit: 'characters', build: (n) => doc(paragraph(text(`a${' \t'.repeat(n / 2)}x`))) },
  { name: 'spaces inside an emphasised run', unit: 'characters', build: (n) => doc(paragraph(text('a'), text(`${' '.repeat(n)}y`, 'emphasis'), text('x'))) },
  { name: 'spaces at the end of a block', unit: 'characters', build: (n) => doc(paragraph(text(`a${' '.repeat(n)}`))) },
  { name: 'spaces in a heading', unit: 'characters', build: (n) => doc({ type: 'paragraph', attrs: { level: 2 }, content: [text(`a${' '.repeat(n)}x`)] }) },
  { name: 'spaces in inline code', unit: 'characters', build: (n) => doc(paragraph(text('a'), text(`${' '.repeat(n)}c${' '.repeat(n)}`, 'inlineCode'), text('x'))) },
  { name: 'opening brackets', unit: 'characters', build: (n) => doc(paragraph(text('['.repeat(n)))) },
  { name: 'closing brackets', unit: 'characters', build: (n) => doc(paragraph(text(']'.repeat(n)))) },
  { name: 'backticks', unit: 'characters', build: (n) => doc(paragraph(text('`'.repeat(n)))) },
  { name: 'asterisks', unit: 'characters', build: (n) => doc(paragraph(text('*'.repeat(n)))) },
  { name: 'underscores', unit: 'characters', build: (n) => doc(paragraph(text('_'.repeat(n)))) },
  { name: 'angle brackets and ampersands', unit: 'characters', build: (n) => doc(paragraph(text('<&'.repeat(n / 2)))) },
  { name: 'alternating strong and plain runs', unit: 'runs', build: (n) => doc(paragraph(...Array.from({ length: n }, (_, i) => text('a', ...(i % 2 === 0 ? ['strong'] : []))))) },
  { name: 'alternating emphasis and strong runs', unit: 'runs', build: (n) => doc(paragraph(...Array.from({ length: n }, (_, i) => text('a', i % 2 === 0 ? 'emphasis' : 'strong')))) },
  { name: 'alternating nested marks', unit: 'runs', build: (n) => doc(paragraph(...Array.from({ length: n }, (_, i) => text('a', ...(i % 3 === 0 ? ['emphasis', 'strong'] : i % 3 === 1 ? ['strong'] : ['emphasis', 'strike_through']))))) },
  { name: 'alternating links', unit: 'runs', build: (n) => doc(paragraph(...Array.from({ length: n }, (_, i) => ({ type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: `u${i % 2}`, title: null } }] })))) },
  { name: 'alternating code and text', unit: 'runs', build: (n) => doc(paragraph(...Array.from({ length: n }, (_, i) => text('a', ...(i % 2 === 0 ? ['inlineCode'] : []))))) },
  { name: 'hard breaks', unit: 'runs', build: (n) => doc(paragraph(...Array.from({ length: n }, (_, i) => (i % 2 === 0 ? text('a') : { type: 'hardbreak', attrs: { isInline: true } })))) },
  { name: 'raw html nodes', unit: 'runs', build: (n) => doc(paragraph(...Array.from({ length: n }, (_, i) => (i % 2 === 0 ? text('a') : { type: 'html', attrs: { value: '<b>' } })))) },
  {
    name: 'deeply nested bullet lists with text',
    unit: 'characters',
    build: (n) => {
      const depth = 45;
      const level = (d: number): Json => ({
        type: 'bullet_list',
        attrs: { spread: false },
        content: [{ type: 'list_item', attrs: { label: '\u2022', listType: 'bullet', spread: false, checked: null }, content: [paragraph(text('x'.repeat(Math.floor(n / depth)))), ...(d < depth ? [level(d + 1)] : [])] }],
      });
      return doc(level(1));
    },
  },
  {
    name: 'many list items',
    unit: 'runs',
    build: (n) => doc({ type: 'bullet_list', attrs: { spread: false }, content: Array.from({ length: n }, () => ({ type: 'list_item', attrs: { label: '\u2022', listType: 'bullet', spread: false, checked: null }, content: [paragraph(text('a'))] })) }),
  },
  { name: 'many paragraphs', unit: 'runs', build: (n) => doc(...Array.from({ length: n }, () => paragraph(text('a')))) },
  {
    name: 'one table with many cells',
    unit: 'runs',
    build: (n) => {
      const cell = (type: string): Json => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, alignment: null }, content: [paragraph(text('c'))] });
      return doc({ type: 'table', content: [{ type: 'table_header_row', content: Array.from({ length: n / 10 }, () => cell('table_header')) }, ...Array.from({ length: 9 }, (): Json => ({ type: 'table_row', content: Array.from({ length: n / 10 }, () => cell('table_cell')) }))] });
    },
  },
  { name: 'raw html with a long attribute list', unit: 'characters', build: (n) => doc(paragraph(text('a'), { type: 'html', attrs: { value: `<a${' b'.repeat(n / 2)}` } })) },
  { name: 'raw html with a long unquoted value', unit: 'characters', build: (n) => doc(paragraph(text('a'), { type: 'html', attrs: { value: `<a b=${'c'.repeat(n)}` } })) },
  { name: 'raw html comment never closed', unit: 'characters', build: (n) => doc(paragraph({ type: 'html', attrs: { value: `<!--${'-'.repeat(n)}` } })) },
  { name: 'raw html of many tags', unit: 'characters', build: (n) => doc(paragraph({ type: 'html', attrs: { value: '<b>x</b>'.repeat(n / 8) } })) },
  { name: 'one very long link address', unit: 'characters', build: (n) => doc(paragraph({ type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: `https://x.y/${'p'.repeat(n)}`, title: null } }] })) },
  { name: 'many links', unit: 'runs', build: (n) => doc(paragraph(...Array.from({ length: n }, (_, i) => ({ type: 'text', text: i % 2 === 0 ? 'a' : ' ', marks: i % 2 === 0 ? [{ type: 'link', attrs: { href: `https://x.y/${i}`, title: null } }] : [] })))) },
  { name: 'many images', unit: 'runs', build: (n) => doc(paragraph(...Array.from({ length: n }, (_, i) => ({ type: 'image', attrs: { src: `https://x.y/${i}.png`, alt: 'i', title: '', href: '', linkTitle: '' } })))) },
  { name: 'text with line endings', unit: 'characters', build: (n) => doc(paragraph(text('a\r\nb\rc\n'.repeat(n / 8)))) },
  { name: 'text with edge spaces around marks', unit: 'runs', build: (n) => doc(paragraph(...Array.from({ length: n }, (_, i) => text(i % 2 === 0 ? ' a ' : 'b', ...(i % 2 === 0 ? ['emphasis'] : []))))) },
  ...gapShapes,
];
