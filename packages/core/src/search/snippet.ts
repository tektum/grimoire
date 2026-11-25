/** What a snippet is: plain text and the `[start, end)` offsets (UTF-16 code units) of the words that matched. It holds no markup. */
export interface Snippet {
  readonly text: string;
  readonly ranges: readonly (readonly [number, number])[];
}

/** The sentinels `ts_headline` is told to put around a match. The text it is given has both removed first, so every one in its output is ours. */
export const MATCH_START = '\u0001';
export const MATCH_END = '\u0002';
export const SNIPPET_MAX_CHARS = 300;
export const SNIPPET_FALLBACK_CHARS = 160;

const SENTINELS = /[\u0001\u0002]/g;

/** `text` cut to `max` UTF-16 units, without leaving half of a surrogate pair at the end. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * Turns the output of `ts_headline` (matches between U+0001 and U+0002) into a snippet: the sentinels are removed and become offsets. A sentinel that is not
 * paired is dropped, and the text is cut at 300 characters with the ranges kept inside it. When the headline holds no match (the page matched by its title only, or
 * the match lies beyond the part of the page that was searched for a snippet), the snippet is the first 160 characters of `fallback` with no ranges.
 */
export function splitSnippet(headline: string | null, fallback: string): Snippet {
  let text = '';
  const ranges: [number, number][] = [];
  let open = -1;
  for (const ch of headline ?? '') {
    if (ch === MATCH_START) {
      if (open < 0) open = text.length;
    } else if (ch === MATCH_END) {
      if (open >= 0 && text.length > open) ranges.push([open, text.length]);
      open = -1;
    } else {
      text += ch;
    }
  }
  if (ranges.length === 0) return { text: cut(fallback.replace(SENTINELS, ''), SNIPPET_FALLBACK_CHARS), ranges: [] };
  const clipped = cut(text, SNIPPET_MAX_CHARS);
  const kept: [number, number][] = [];
  for (const [a, b] of ranges) {
    if (a >= clipped.length) break;
    kept.push([a, Math.min(b, clipped.length)]);
  }
  return { text: clipped, ranges: kept };
}
