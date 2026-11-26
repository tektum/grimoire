import { describe, expect, it } from 'vitest';
import { createMarkdownConverter } from '@tektum/grimoire-adapter-markdown-milkdown';
import { convertConstructs } from '../../../src/import/notion/constructs.js';

// M7 contracts section 4, Notion constructs: a callout (`<aside>`) is a quote whose first line is bold, the emoji inside the bold (Q37 = A); a toggle (`<details><summary>`) is
// its summary as a bold paragraph, then its content (Q38 = A). Both are converted before the schema sees them, so their text is the page's text. The shapes are those a real export
// writes (M7-T08): the tags on lines of their own, blank lines inside, lists inside, indented inside a list item, nested.
const lines = (...l: string[]): string => `${l.join('\n')}\n`;

describe('a callout', () => {
  it('becomes a quote whose first line is bold with the emoji inside, the rest quoted, the blank lines kept inside the quote', () => {
    expect(convertConstructs(lines('Before', '', '<aside>', '💡 Keep the receipts', 'They are needed in March.', '', '</aside>', '', 'After'))).toBe(
      lines('Before', '', '> **💡 Keep the receipts**', '> They are needed in March.', '', 'After'),
    );
  });

  it('bolds a first line without an emoji, and takes the bold of the line apart so that the bold is not broken', () => {
    expect(convertConstructs(lines('<aside>', '**Note:** read the [guide](Guide%20a.md)', '', '</aside>'))).toBe(lines('> **Note: read the [guide](Guide%20a.md)**'));
  });

  it('takes apart only the bold of the text itself: a link\'s target, a code span and a word keep their __ and ** (they are characters of a name)', () => {
    expect(convertConstructs(lines('<aside>', 'See [spec](my__notes.md), run `a**b` on the snake__case name **now**', '</aside>'))).toBe(lines('> **See [spec](my__notes.md), run `a**b` on the snake__case name now**'));
  });

  it('keeps an icon picture as it is and bolds the first line of text after it', () => {
    expect(convertConstructs(lines('<aside>', '<img src="icon.png" alt="x" width="40px" />', 'Plan ahead', 'More', '', '</aside>'))).toBe(
      lines('> <img src="icon.png" alt="x" width="40px" />', '> **Plan ahead**', '> More'),
    );
  });

  it('quotes a list inside it, and a blank line between two paragraphs stays inside the quote', () => {
    expect(convertConstructs(lines('<aside>', '📌 Steps', '', '- one', '- two', '', 'Done.', '', '</aside>'))).toBe(lines('> **📌 Steps**', '>', '> - one', '> - two', '>', '> Done.'));
  });

  it('inside a list item keeps the indentation of the item', () => {
    expect(convertConstructs(lines('- item', '    <aside>', '    ⚠️ Careful', '    ', '    </aside>', '- next'))).toBe(lines('- item', '    > **⚠️ Careful**', '- next'));
  });

  it('nested in another callout is a quote in the quote', () => {
    expect(convertConstructs(lines('<aside>', '💡 Outer', '<aside>', '🔥 Inner', '', '</aside>', '', '</aside>'))).toBe(lines('> **💡 Outer**', '> > **🔥 Inner**'));
  });

  it('that opens with a callout nested in it has that one as its first line: its own text after the nested one is not bold', () => {
    expect(convertConstructs(lines('<aside>', '<aside>', '🔥 Inner', '', '</aside>', '', 'Outer text', '', '</aside>'))).toBe(lines('> > **🔥 Inner**', '>', '> Outer text'));
  });

  it('inside a code fence that shows Markdown, a fence line with an info string does not close it (CommonMark): the callout in the code stays as it is', () => {
    const code = lines('```', '```js', '<aside>', 'x', '</aside>', '```', 'After');
    expect(convertConstructs(code)).toBe(code);
  });

  it('inside a code fence is code and stays exactly as it is; a callout that is never closed stays as it is', () => {
    const fenced = lines('```html', '<aside>', 'x', '</aside>', '```');
    expect(convertConstructs(fenced)).toBe(fenced);
    const open = lines('<aside>', '💡 never closed', 'text');
    expect(convertConstructs(open)).toBe(open);
  });
});

describe('a toggle', () => {
  it('whose summary is empty becomes its content only (bold around nothing would be a rule)', () => {
    expect(convertConstructs(lines('<details>', '<summary></summary>', 'Hidden text', '</details>'))).toBe(lines('', 'Hidden text'));
  });

  it('becomes its summary as a bold paragraph, then its content', () => {
    expect(convertConstructs(lines('<details>', '<summary>More detail</summary>', '', 'Hidden text', '', '</details>', 'After'))).toBe(lines('**More detail**', '', 'Hidden text', '', 'After'));
  });
});

describe('with the real converter', () => {
  it('the converted text is the page\'s text (searchable) and no aside or details block is left in the stored Markdown', async () => {
    const converter = createMarkdownConverter({ maxStateBytes: 1_000_000, maxSeedMarkdownBytes: 131_072, seedTimeoutMs: 10_000, reseedTimeoutMs: 30_000, poolSize: 1, closeDeadlineMs: 5000, timeoutMs: 10_000 });
    try {
      const source = lines('# Page', '', '<aside>', '💡 Remember the lantern', 'Bring oil as well.', '', '</aside>', '', '<details>', '<summary>Old notes</summary>', '', 'Kept under the stairs.', '', '</details>');
      const seeded = await converter.seed(convertConstructs(source), 'user-1');
      if (!seeded.ok) throw new Error('not seeded');
      const back = await converter.toMarkdown(seeded.state);
      if (!back.ok) throw new Error('not converted back');
      for (const words of ['Remember the lantern', 'Bring oil as well', 'Old notes', 'Kept under the stairs']) expect(back.text).toContain(words);
      expect(back.markdown).not.toMatch(/<\/?(aside|details|summary)>/);
      expect(back.markdown).toContain('> **💡 Remember the lantern**');
    } finally {
      await converter.close();
    }
  }, 30_000);

  it('a toggle whose summary starts with links reads back as the same document, as a callout\'s first line does: that summary is not bold', async () => {
    const converter = createMarkdownConverter({ maxStateBytes: 1_000_000, maxSeedMarkdownBytes: 131_072, seedTimeoutMs: 10_000, reseedTimeoutMs: 30_000, poolSize: 1, closeDeadlineMs: 5000, timeoutMs: 10_000 });
    try {
      const converted = convertConstructs(lines('<details>', '<summary>[Alpha](Alpha%20Page.md) [Beta](Beta%20Page.md)</summary>', '', 'Hidden text', '', '</details>'));
      expect(converted).toBe(lines('[Alpha](Alpha%20Page.md) [Beta](Beta%20Page.md)', '', 'Hidden text', ''));
      const seeded = await converter.seed(converted, 'user-1');
      if (!seeded.ok) throw new Error('not seeded');
      expect((await converter.toMarkdown(seeded.state)).ok).toBe(true);
    } finally {
      await converter.close();
    }
  }, 30_000);

  it('a callout whose first line starts with links reads back as the same document (bold across links would not, and the page would fail): that line is not bold', async () => {
    const converter = createMarkdownConverter({ maxStateBytes: 1_000_000, maxSeedMarkdownBytes: 131_072, seedTimeoutMs: 10_000, reseedTimeoutMs: 30_000, poolSize: 1, closeDeadlineMs: 5000, timeoutMs: 10_000 });
    try {
      const converted = convertConstructs(lines('<aside>', '[Alpha](Alpha%20Page.md) [Beta](Beta%20Page.md)', 'See both.', '', '</aside>'));
      expect(converted).toBe(lines('> [Alpha](Alpha%20Page.md) [Beta](Beta%20Page.md)', '> See both.'));
      const seeded = await converter.seed(converted, 'user-1');
      if (!seeded.ok) throw new Error('not seeded');
      expect((await converter.toMarkdown(seeded.state)).ok).toBe(true);
    } finally {
      await converter.close();
    }
  }, 30_000);

  it('a first line or summary that starts with a bold link is not bold either: bold across two links would not read back', () => {
    expect(convertConstructs(lines('<aside>', '**[Alpha](A.md)** and [Beta](B.md)', '</aside>'))).toBe(lines('> **[Alpha](A.md)** and [Beta](B.md)'));
    expect(convertConstructs(lines('<details>', '<summary>**[Alpha](A.md)** and [Beta](B.md)</summary>', 'Text', '</details>'))).toBe(lines('**[Alpha](A.md)** and [Beta](B.md)', 'Text'));
  });

  it('a line of unclosed link targets is read in linear time', () => {
    const started = performance.now();
    convertConstructs(lines('<aside>', `x${'](a'.repeat(200_000)}`, '</aside>'));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('callouts nested deeper than the limit stay as text, so a crafted page cannot multiply its lines by its depth', () => {
    const depth = 3000;
    const page = lines(...Array.from({ length: depth }, () => '<aside>'), ...Array.from({ length: 20_000 }, () => ''), ...Array.from({ length: depth }, () => '</aside>'));
    const started = performance.now();
    const converted = convertConstructs(page);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(converted.length).toBeLessThan(page.length * 10);
  });
});
