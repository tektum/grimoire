import { describe, expect, it } from 'vitest';
import { convertInProcess } from '../../src/index.js';
import { stateFromMarkdown } from '../../src/testing/states.js';

async function textOf(markdown: string): Promise<string> {
  const result = await convertInProcess(await stateFromMarkdown(markdown));
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return result.text;
}

/**
 * Rules (contracts section 4, step 6; R7.5): `textBetween` with '\n' between blocks. Words in adjacent blocks, list items
 * and table cells never run together. Formatting characters are not in the text. Code block text is included as written.
 * A link contributes its text, not its URL. An image contributes its alt text, not its URL. A hard break is a space.
 * Raw HTML nodes contribute nothing (their tags are dropped; text between inline tags stays).
 */
describe('search text', () => {
  it('puts every block on its own line', async () => {
    expect(await textOf('# Title\n\nfirst paragraph\n\nsecond paragraph\n')).toBe('Title\nfirst paragraph\nsecond paragraph');
  });

  it('puts list items and nested items on their own lines', async () => {
    expect(await textOf('- one\n- two\n  - three\n\n1. four\n2. five\n')).toBe('one\ntwo\nthree\nfour\nfive');
  });

  it('puts table cells on their own lines', async () => {
    expect(await textOf('| a | b |\n|---|---|\n| c | d |\n')).toBe('a\nb\nc\nd');
  });

  it('includes code block text, with its own line breaks', async () => {
    expect(await textOf('before\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nafter\n')).toBe(
      'before\nconst a = 1;\nconst b = 2;\nafter',
    );
  });

  it('includes image alt text and no URL', async () => {
    const text = await textOf('see ![a red door](https://example.com/door.png "Title") here\n');
    expect(text).toBe('see a red door here');
    expect(text).not.toContain('example.com');
  });

  it('includes the text of a link and not its URL', async () => {
    const text = await textOf('read [the guide](https://example.com/guide "Guide") now\n');
    expect(text).toBe('read the guide now');
  });

  it('keeps the alt text of an image inside a link, and not the link URL', async () => {
    expect(await textOf('[![logo](logo.png)](https://example.com)\n')).toBe('logo');
  });

  it('excludes the content of block raw HTML, and leaves no empty line for it', async () => {
    const text = await textOf('before\n\n<div>\n<p>hidden words</p>\n</div>\n\nafter\n');
    expect(text).toBe('before\nafter');
    expect(text).not.toContain('hidden');
  });

  it('has no leading or trailing line break when the page starts or ends with raw HTML', async () => {
    expect(await textOf('<div>x</div>\n\ntext\n\n<div>y</div>\n')).toBe('text');
  });

  it('keeps the URL of an autolink: it is the visible text, on purpose', async () => {
    expect(await textOf('see <https://example.com/a> now\n')).toBe('see https://example.com/a now');
  });

  it('drops the tags of inline raw HTML and keeps the text between them', async () => {
    expect(await textOf('a <span class="x">visible</span> b\n')).toBe('a visible b');
  });

  it('turns a hard break into a space', async () => {
    expect(await textOf('one\\\ntwo\n')).toBe('one two');
  });

  it('has no Markdown syntax characters from formatting', async () => {
    const text = await textOf('## **bold** *em* `code` ~~gone~~ [l](u)\n\n> quote\n\n* item\n');
    expect(text).toBe('bold em code gone l\nquote\nitem');
  });

  it('keeps characters the author typed as text', async () => {
    expect(await textOf('1 \\* 2 \\# 3\n')).toBe('1 * 2 # 3');
  });

  it('is empty for an empty page', async () => {
    expect(await textOf('')).toBe('');
  });
});
