/**
 * Seeded Markdown generators for the tests and the benchmark. A small copy of the approach of
 * packages/editor-schema/test/benchmark/size-ratio.test.ts: that file registers its own tests when imported, and the
 * layout rules keep one package's tests out of another's, so it cannot be shared.
 */

const WORDS = [
  'the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'server', 'converts', 'live', 'state', 'into',
  'canonical', 'markdown', 'for', 'every', 'page', 'document', 'editor', 'schema', 'paragraph', 'heading', 'table',
  'caf\u00e9', '\u65e5\u672c\u8a9e', 'x', '2024', 'a_b', '1.5',
];

/** Linear congruential generator: the same sequence on every run. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

type Next = () => number;
const pick = <T>(items: readonly T[], next: Next): T => items[Math.floor(next() * items.length)] as T;
const word = (next: Next): string => pick(WORDS, next);
const words = (next: Next, count: number): string => Array.from({ length: count }, () => word(next)).join(' ');

export type Shape = 'prose' | 'lists' | 'tables' | 'code' | 'mixed';
export const SHAPES: readonly Shape[] = ['prose', 'lists', 'tables', 'code', 'mixed'];

const UNITS: Record<Shape, (next: Next, i: number) => string> = {
  prose: (next, i) =>
    `${i % 12 === 0 ? `## Section ${i}\n\n` : ''}${words(next, 40 + Math.floor(next() * 40))}. **bold ${i}** and _em_ and [link](https://example.com/${i}).\n`,
  lists: (next, i) =>
    `${i % 6 === 0 ? `### List ${i}\n\n` : ''}${Array.from({ length: 6 }, (_, k) => `- item ${k} ${words(next, 2)}\n  - nested ${word(next)}\n`).join('')}\n1. first ${word(next)}\n2. second\n3. third\n\n- [ ] todo ${word(next)}\n- [x] done\n`,
  tables: (next, i) =>
    `| id | name | owner | status | notes |\n| - | - | - | - | - |\n${Array.from({ length: 8 }, (_, k) => `| ${i * 8 + k} | ${word(next)} | ${word(next)} | ${next() < 0.5 ? 'open' : 'done'} | ${words(next, 2)} |`).join('\n')}\n`,
  code: (next, i) =>
    `\`\`\`ts\nexport function fn${i}(a: number, b: number): number {\n${Array.from({ length: 20 }, (_, k) => `  const v${k} = a * ${k} + b - ${Math.floor(next() * 1000)}; // ${word(next)}`).join('\n')}\n  return a;\n}\n\`\`\`\n`,
  mixed: (next, i) =>
    `# Doc part ${i}\n\n${words(next, 25)} with \`code\` and **bold**.\n\n- a ${i}\n- b\n\n> quote ${word(next)}\n\n| a | b |\n| - | - |\n| ${word(next)} | ${word(next)} |\n\n\`\`\`sh\nnpm run build ${i}\n\`\`\`\n`,
};

/** Markdown of one shape, grown unit by unit until it reaches about `bytes` bytes. Same seed, same text. */
export function generateMarkdown(shape: Shape, bytes: number, seed = 7): string {
  const next = random(seed);
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i += 1) {
    const unit = UNITS[shape](next, i);
    parts.push(unit);
    size += Buffer.byteLength(unit, 'utf8') + 1; // UTF-8 bytes, as the target says
  }
  return parts.join('\n');
}

/** `count` single-line paragraphs: the shape that stresses the serializer's block count. */
export function generateBlocks(count: number): string {
  return Array.from({ length: count }, (_, i) => `paragraph ${i}`).join('\n\n') + '\n';
}

const MARKS: readonly ((text: string) => string)[] = [
  (t) => `*${t}*`,
  (t) => `**${t}**`,
  (t) => `\`${t}\``,
  (t) => `~~${t}~~`,
  (t) => `[${t}](https://example.com/${encodeURIComponent(t)})`,
  (t) => `[*${t}* and **${t}**](https://example.com "T")`,
  (t) => `***${t}***`,
];

function inline(next: Next): string {
  const parts: string[] = [];
  const count = 1 + Math.floor(next() * 5);
  for (let i = 0; i < count; i += 1) {
    const roll = next();
    const text = words(next, 1 + Math.floor(next() * 4));
    if (roll < 0.45) parts.push(text);
    else if (roll < 0.8) parts.push(pick(MARKS, next)(text));
    else if (roll < 0.86) parts.push(`![${text}](https://example.com/${i}.png)`);
    else if (roll < 0.9) parts.push(`[![${text}](i${i}.png)](https://example.com/l${i} "t")`);
    else if (roll < 0.94) parts.push(`${text}\\\n${word(next)}`);
    else if (roll < 0.97) parts.push(`<kbd>${text}</kbd>`);
    else parts.push('\\* \\# \\[x\\] &amp;');
  }
  return parts.join(' ');
}

function block(next: Next, depth: number): string {
  const roll = next();
  if (roll < 0.3 || depth > 3) return inline(next);
  if (roll < 0.4) return `${'#'.repeat(1 + Math.floor(next() * 6))} ${inline(next)}`;
  if (roll < 0.55) {
    const items = Array.from({ length: 1 + Math.floor(next() * 4) }, () => block(next, depth + 1));
    const kind = next();
    const loose = next() < 0.3 ? '\n\n' : '\n';
    return items
      .map((item, i) => {
        const marker = kind < 0.4 ? '-' : kind < 0.8 ? `${i + 1}.` : '- [ ]';
        return `${marker} ${item.split('\n').join('\n  ')}`;
      })
      .join(loose);
  }
  if (roll < 0.65) return block(next, depth + 1).split('\n').map((l) => `> ${l}`).join('\n');
  if (roll < 0.75) {
    const align = pick(['|-|-|', '|:-|-:|', '|:-:|:-:|', '|-|:-|'], next);
    return `| a | b |\n${align}\n| ${inline(next).replaceAll('\n', ' ')} | ${word(next)} |\n| ${word(next)} | ${word(next)} |`;
  }
  if (roll < 0.85) return `\`\`\`${pick(['ts', 'sh', '', 'json'], next)}\n${words(next, 6)}\n\n  ${words(next, 3)}\n\`\`\``;
  if (roll < 0.9) return pick(['***', '---', '___'], next);
  if (roll < 0.95) return `<div>${words(next, 2)}</div>`;
  return '';
}

/** A random document of 1 to 12 blocks, for the sweeps of the loss check and of the round trip. */
export function generateRandomDocument(seed: number): string {
  const next = random(seed * 7919 + 13);
  const count = 1 + Math.floor(next() * 12);
  return Array.from({ length: count }, () => block(next, 0)).join('\n\n') + '\n';
}

/** Constructs the plain generator leaves out: each one is in a class that the converter accepts or refuses on purpose. */
const WILD: readonly ((next: Next) => string)[] = [
  (n) => `write to ${word(n)}@example.com or see http://example.com/${word(n)} or www.example.org now`, // address becomes link
  (n) => `- [ ] # ${words(n, 2)}`, // task checkbox before a heading
  (n) => `## ${word(n)}\\\n${word(n)}`, // hard break inside a heading
  (n) => `| a | b |\n|-|-|\n| ${word(n)}\\\n${word(n)} | x |`, // hard break inside a cell
  (n) => `*\`${word(n)}\`* and \`${word(n)}\`${word(n)}`, // inline code with other marks or touching text
  (n) => `${word(n)}\n\n3. ${word(n)}\n4. ${word(n)}`, // list not starting at 1 after a paragraph
  (n) => `> ${word(n)}\n>\n> 5. ${word(n)}`, // ... in a quote
  (n) => `**${word(n)}**[${word(n)}](https://e.com/${word(n)})*${word(n)}*`, // link between emphasised runs
  (n) => `${word(n)} **bold **${word(n)}`, // space at the edge of a marked run
  (n) => `${word(n)}\\\n`, // hard break at the end of a block
];

/** A random document of plain blocks with one to three of the constructs above (`WILD`) mixed in. */
export function generateWildDocument(seed: number): string {
  const next = random(seed * 104729 + 7);
  const parts: string[] = [];
  const count = 1 + Math.floor(next() * 3);
  for (let i = 0; i < count; i += 1) {
    parts.push(block(next, 0));
    parts.push(pick(WILD, next)(next));
  }
  return parts.join('\n\n') + '\n';
}

/** Plain JSON of a ProseMirror document, the shape `Node.fromJSON` reads. */
export interface DocJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocJson[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

const ADDRESSES = ['http://example.com/a', 'www.example.org', 'me@example.com', 'https://example.com/x?y=1'];
const MARK_SETS: DocJson['marks'][] = [
  undefined, undefined, undefined,
  [{ type: 'strong' }], [{ type: 'emphasis' }], [{ type: 'inlineCode' }], [{ type: 'strike_through' }],
  [{ type: 'strong' }, { type: 'emphasis' }],
  [{ type: 'link', attrs: { href: 'https://example.com/l', title: null } }],
];

function editorInline(next: Next): DocJson[] {
  const out: DocJson[] = [];
  const count = 1 + Math.floor(next() * 4);
  for (let i = 0; i < count; i += 1) {
    const roll = next();
    if (roll < 0.1) out.push({ type: 'hardbreak', attrs: { isInline: true } });
    else if (roll < 0.17) out.push({ type: 'text', text: pick(ADDRESSES, next) }); // plain text that looks like an address
    else if (roll < 0.22) out.push({ type: 'text', text: ` ${word(next)} `, marks: [{ type: 'strong' }] }); // spaces inside a mark
    else {
      const marks = pick(MARK_SETS, next);
      out.push({ type: 'text', text: `${word(next)} ${word(next)}`, ...(marks ? { marks } : {}) });
    }
  }
  return out;
}

function editorParagraph(next: Next): DocJson {
  const empty = next() < 0.12;
  const level = next() < 0.2 ? 1 + Math.floor(next() * 6) : 0;
  return { type: 'paragraph', attrs: { level }, ...(empty ? {} : { content: editorInline(next) }) };
}

function editorBlock(next: Next, depth: number): DocJson {
  const roll = next();
  if (roll < 0.35 || depth > 2) return editorParagraph(next);
  if (roll < 0.6) {
    const ordered = next() < 0.4;
    const task = !ordered && next() < 0.3;
    const order = next() < 0.7 ? 1 : 2 + Math.floor(next() * 3);
    const items = Array.from({ length: 1 + Math.floor(next() * 3) }, (_, index) => ({
      type: 'list_item',
      attrs: { label: ordered ? `${order + index}.` : '\u2022', listType: ordered ? 'ordered' : 'bullet', spread: false, checked: task ? next() < 0.5 : null },
      content: [editorParagraph(next), ...(next() < 0.5 ? [editorBlock(next, depth + 1)] : [])],
    }));
    return { type: ordered ? 'ordered_list' : 'bullet_list', attrs: ordered ? { order, spread: false } : { spread: false }, content: items };
  }
  if (roll < 0.7) return { type: 'blockquote', content: [editorBlock(next, depth + 1), editorBlock(next, depth + 1)] };
  if (roll < 0.8) return { type: 'code_block', attrs: { language: pick(['', 'ts', 'sh'], next) }, content: [{ type: 'text', text: `${words(next, 3)}\n\n  ${word(next)}` }] };
  if (roll < 0.9) {
    // One alignment per column, as the editor sets it: Markdown keeps it on the column, not on the cell.
    const columns = [pick([null, 'left', 'center', 'right'], next), pick([null, 'left', 'center', 'right'], next)];
    let column = 0;
    const cell = (type: string): DocJson => ({ type, attrs: { alignment: columns[column++ % 2] }, content: [{ type: 'paragraph', attrs: { level: 0 }, ...(next() < 0.2 ? {} : { content: editorInline(next) }) }] });
    return {
      type: 'table',
      content: [
        { type: 'table_header_row', content: [cell('table_header'), cell('table_header')] },
        { type: 'table_row', content: [cell('table_cell'), cell('table_cell')] },
      ],
    };
  }
  return { type: 'hr' };
}

/**
 * A document as an editor can make it, not as a Markdown reader would: empty paragraphs and items anywhere, headings
 * with hard breaks and with a task item, plain text that looks like an address, spaces at the edge of marked runs, lists
 * that do not start at 1. These are the documents on which the read-back differs from the written one.
 */
export function generateEditorDocument(seed: number): DocJson {
  const next = random(seed * 15485863 + 11);
  const count = 1 + Math.floor(next() * 6);
  return { type: 'doc', content: Array.from({ length: count }, () => editorBlock(next, 0)) };
}
