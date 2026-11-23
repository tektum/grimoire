import { describe, expect, it } from 'vitest';
import { CLOSING_BRACKET_LIMIT } from '@tektum/grimoire-editor-schema';
import { convertInProcess } from '../../src/index.js';
import { stateFromDocJson } from '../../src/testing/states.js';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; marks?: { type: string; attrs?: Record<string, unknown> }[]; text?: string };
const text = (value: string, ...marks: string[]): Json => ({ type: 'text', text: value, ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}) });
const paragraph = (...content: Json[]): Json => ({ type: 'paragraph', attrs: { level: 0 }, content });
const doc = (...blocks: Json[]): Json => ({ type: 'doc', content: blocks });
const closers = (n: number): string => ']'.repeat(n);

async function markdownOf(json: Json): Promise<string> {
  const result = await convertInProcess(await stateFromDocJson(json));
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return result.markdown;
}
/** `]` that no backslash escapes (an odd run of backslashes before it escapes it). */
const unescaped = (markdown: string): number => {
  let count = 0;
  let backslashes = 0;
  for (const char of markdown) {
    if (char === ']' && backslashes % 2 === 0) count += 1;
    backslashes = char === '\\' ? backslashes + 1 : 0;
  }
  return count;
};

/** The footnote tokenizer of the parser walks back over every earlier event for each `]` with no `[`: the verifying parse of a save is quadratic in their number. */
describe('a document with more than the limit of `]` in text', () => {
  it('keeps the bytes of ordinary text, and of exactly the limit', async () => {
    expect(await markdownOf(doc(paragraph(text('see [1] and a] b'))))).toBe('see \\[1] and a] b\n');
    const atLimit = await markdownOf(doc(paragraph(text(closers(CLOSING_BRACKET_LIMIT)))));
    expect(atLimit).toBe(`${closers(CLOSING_BRACKET_LIMIT)}\n`);
  });

  it('writes every `]` as `\\]` one past the limit, and the Markdown reads back as the same document (the converter verifies the round trip)', async () => {
    const markdown = await markdownOf(doc(paragraph(text(closers(CLOSING_BRACKET_LIMIT + 1)))));
    expect(markdown).toBe(`${'\\]'.repeat(CLOSING_BRACKET_LIMIT + 1)}\n`);
  });

  it('counts the whole document: brackets split over text nodes of 63 between marks, over many paragraphs, and inside lists, quotes and headings', async () => {
    const pieces = Array.from({ length: 80 }, (_, i) => [text(closers(63)), text(` w${String(i)} `, 'emphasis')]).flat();
    const manyNodes = await markdownOf(doc(paragraph(...pieces)));
    expect(unescaped(manyNodes)).toBe(0);
    expect(manyNodes.split('\\]').length - 1).toBe(80 * 63);
    const manyBlocks = await markdownOf(doc(...Array.from({ length: 100 }, () => paragraph(text(closers(63))))));
    expect(unescaped(manyBlocks)).toBe(0);
    const nested = await markdownOf(doc(
      { type: 'blockquote', content: [paragraph(text(closers(700)))] },
      { type: 'bullet_list', content: [{ type: 'list_item', attrs: { spread: false }, content: [paragraph(text(closers(700)))] }] },
      { type: 'paragraph', attrs: { level: 2 }, content: [text(closers(700))] },
    ));
    expect(unescaped(nested)).toBe(0);
  });

  it('leaves code alone, and does not escape a `]` twice', async () => {
    const code = closers(50);
    const markdown = await markdownOf(doc(
      paragraph(text(closers(CLOSING_BRACKET_LIMIT + 5)), text(code, 'inlineCode'), text(' a\\] b ]')),
      { type: 'code_block', attrs: { language: '' }, content: [text(closers(3000))] },
    ));
    expect(markdown).toContain(`\`${code}\``);
    expect(markdown).toContain(`\`\`\`\n${closers(3000)}\n\`\`\``);
    expect(markdown).toContain(' a\\\\\\] b \\]');
    expect(markdown.replace(code, '').replace(closers(3000), '')).not.toMatch(/(?<!\\)\]/);
  });

  it('leaves the `]` of a link alone and escapes the one in its text once', async () => {
    const markdown = await markdownOf(doc(paragraph(text(closers(CLOSING_BRACKET_LIMIT + 1)), { type: 'text', text: 'a]b', marks: [{ type: 'link', attrs: { href: 'https://example.com/', title: null } }] })));
    expect(markdown).toContain('[a\\]b](https://example.com/)');
    expect(markdown).not.toContain('\\\\]');
  });

  it('leaves an autolink alone: its text is its address, and a backslash is not an escape inside `<...>`', async () => {
    const address = 'https://example.com/a]b]';
    const markdown = await markdownOf(doc(paragraph(
      text(closers(CLOSING_BRACKET_LIMIT + 1)),
      { type: 'text', text: address, marks: [{ type: 'link', attrs: { href: address, title: null } }] },
    )));
    expect(markdown).toContain(`<${address}>`);
    expect(markdown).not.toContain(`<${address.replaceAll(']', '\\]')}>`);
    expect(markdown.replace(`<${address}>`, '')).not.toMatch(/(?<!\\)\]/);
  });
});
