import { describe, expect, it } from 'vitest';
import { SNIPPET_FALLBACK_CHARS, SNIPPET_MAX_CHARS, splitSnippet } from '../../src/search/snippet.js';

const S = '\u0001';
const E = '\u0002';

const inside = (s: { text: string; ranges: readonly (readonly [number, number])[] }) => s.ranges.every(([a, b]) => a >= 0 && a < b && b <= s.text.length);
const apart = (s: { ranges: readonly (readonly [number, number])[] }) => s.ranges.every(([, b], i) => i === 0 || (s.ranges[i - 1] as readonly [number, number])[1] <= (s.ranges[i] as readonly [number, number])[0] && b > 0);

describe('splitSnippet', () => {
  it('removes the sentinels and returns the offsets of the matches', () => {
    expect(splitSnippet(`the ${S}quarterly${E} plan and ${S}plan${E}`, 'ignored')).toEqual({ text: 'the quarterly plan and plan', ranges: [[4, 13], [23, 27]] });
  });

  it('counts offsets in UTF-16 code units', () => {
    const s = splitSnippet(`😀 ${S}go${E}`, 'x');
    expect(s).toEqual({ text: '😀 go', ranges: [[3, 5]] });
  });

  it('keeps markup in the page as plain text: nothing is escaped or parsed', () => {
    const s = splitSnippet(`<script>alert(1)</script> <img src=x onerror=alert(1)> ${S}word${E} &amp;`, 'x');
    expect(s.text).toBe('<script>alert(1)</script> <img src=x onerror=alert(1)> word &amp;');
    expect(s.ranges).toEqual([[55, 59]]);
  });

  it('ignores a sentinel that is not paired, so a page holding U+0001 or U+0002 cannot make a false match', () => {
    const stray = splitSnippet(`a${E}b${S}c${S}d${E}e${S}`, 'x');
    expect(stray.text).toBe('abcde');
    expect(inside(stray) && apart(stray)).toBe(true);
    expect(stray.ranges).toEqual([[2, 4]]); // the first start counts, the second is ignored, the last one never closes
  });

  it('cuts the text at 300 characters and keeps every range inside it, without splitting a surrogate pair', () => {
    const long = `${'a'.repeat(298)}😀 ${S}tail${E}`;
    const s = splitSnippet(long, 'x');
    expect(s.text.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(s.text.endsWith('\ud83d')).toBe(false);
    expect(s.ranges).toEqual([]);
    const partial = splitSnippet(`${'a'.repeat(297)} ${S}wordword${E}`, 'x');
    expect(partial.text).toHaveLength(SNIPPET_MAX_CHARS);
    expect(partial.ranges).toEqual([[298, 300]]);
  });

  it('falls back to the first 160 characters of the page text, with no ranges, when the headline has no match', () => {
    const words = 'word '.repeat(100);
    for (const headline of [null, '', 'no match here', `${S}${E}`]) {
      expect(splitSnippet(headline, `${S}${E}${words}`)).toEqual({ text: words.slice(0, SNIPPET_FALLBACK_CHARS), ranges: [] });
    }
  });

  it('is empty for a page with no text', () => {
    expect(splitSnippet(null, '')).toEqual({ text: '', ranges: [] });
  });

  it('merges nothing and never overlaps, whatever the input', () => {
    for (const input of [`${S}${S}a${E}${E}`, `${E}${S}a`, `${S}a${E}${S}b${E}`, `${S}${E}${S}${E}`]) {
      const s = splitSnippet(input, 'fallback');
      expect(inside(s) && apart(s), JSON.stringify(input)).toBe(true);
    }
  });
});
