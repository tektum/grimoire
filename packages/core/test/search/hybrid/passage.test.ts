import { describe, expect, it } from 'vitest';
import { passageOf, snippetOfPassage } from '../../../src/search/hybrid.js';

describe('the passage of a chunk', () => {
  it('is the plain text of the chunk: [charStart, charEnd) of the text, white space made one space', () => {
    const text = 'Intro line.\n\nThe quarterly   plan\twas approved.\r\nNext paragraph.';
    expect(passageOf(text, 13, 49)).toBe('The quarterly plan was approved.');
    expect(passageOf(text, 0, text.length)).toBe('Intro line. The quarterly plan was approved. Next paragraph.');
  });

  it('cuts a 2,000-character chunk at a word boundary to at most 300 characters', () => {
    const word = 'alpha ';
    const text = word.repeat(400); // 2,400 characters, spaces every 6
    const passage = passageOf(text, 0, 2000);
    expect(passage.length).toBeLessThanOrEqual(300);
    expect(passage.length).toBeGreaterThan(280);
    expect(passage.endsWith('alpha')).toBe(true);
    expect(text.startsWith(passage)).toBe(true);
  });

  it('cuts inside a word only when there is no space to cut at (a long word), and never inside a surrogate pair', () => {
    expect(passageOf('x'.repeat(1000), 0, 1000)).toHaveLength(300);
    const emoji = '\u{1F642}'.repeat(400); // two units each
    const passage = passageOf(emoji, 0, emoji.length);
    expect(passage.length).toBeLessThanOrEqual(300);
    expect(passage.length % 2).toBe(0);
    expect(passage).toBe(emoji.slice(0, passage.length));
  });

  it('does not end on the first half of a surrogate pair that straddles the limit', () => {
    const text = `${'x'.repeat(299)}\u{1F642}${'y'.repeat(50)}`; // the pair sits at units 299 and 300
    expect(passageOf(text, 0, text.length)).toBe('x'.repeat(299));
  });

  it('strips control characters and the two snippet sentinels, keeps the words around them, and has no markup of its own', () => {
    const text = 'a\u0000b\u0001c\u0002d\u0007e\u007ff \u009fg <b>bold</b>';
    expect(passageOf(text, 0, text.length)).toBe('abcdef g <b>bold</b>');
    for (const ch of passageOf(text, 0, text.length)) expect(ch.charCodeAt(0) > 0x1f && (ch.charCodeAt(0) < 0x7f || ch.charCodeAt(0) > 0x9f)).toBe(true);
  });

  it('is empty for offsets outside the text or a chunk of nothing but controls, and clamps offsets that run past the end', () => {
    expect(passageOf('short', 10, 20)).toBe('');
    expect(passageOf('short', 3, 1)).toBe('');
    expect(passageOf('\u0000\u0001 \u0002', 0, 4)).toBe('');
    expect(passageOf('short text', -5, 5000)).toBe('short text');
  });
});

describe('the snippet of a page found only by meaning', () => {
  it('is the first 160 characters of the passage with no ranges, so older clients still show something', () => {
    const passage = 'word '.repeat(60).trim();
    const snippet = snippetOfPassage(passage);
    expect(snippet.text).toBe(passage.slice(0, 160));
    expect(snippet.ranges).toEqual([]);
    expect(snippetOfPassage('short')).toEqual({ text: 'short', ranges: [] });
    expect(snippetOfPassage('')).toEqual({ text: '', ranges: [] });
  });

  it('does not end inside a surrogate pair', () => {
    const passage = `${'x'.repeat(159)}\u{1F642}tail`;
    expect(snippetOfPassage(passage).text).toBe('x'.repeat(159));
  });
});
