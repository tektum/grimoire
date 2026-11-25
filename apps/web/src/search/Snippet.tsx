import type { ReactNode } from 'react';
import type { SearchSnippet } from './types';

/**
 * The ranges that can be drawn: whole numbers, inside the text, in order, not overlapping. A range that is none of these is ignored (the server promises it never sends one; a client does not
 * trust that with text it is about to draw).
 */
export function usableRanges(text: string, ranges: readonly (readonly [number, number])[] | undefined): [number, number][] {
  if (!Array.isArray(ranges)) return [];
  const sorted = ranges
    // An element that is not a pair of numbers is not a range (the answer is not trusted to have the shape: `[null]` and `[1, 2]` are refused here, not destructured).
    .filter((range): range is readonly [number, number] => Array.isArray(range) && range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1]))
    .filter(([start, end]) => start >= 0 && end > start && end <= text.length)
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const kept: [number, number][] = [];
  for (const [start, end] of sorted) if (kept.length === 0 || start >= kept[kept.length - 1]![1]) kept.push([start, end]);
  return kept;
}

/** The snippet as text, with `mark` around the matched words. The text goes to the page as text (React escapes it): no markup of it is ever read, whatever it holds. */
export function Snippet({ snippet }: { readonly snippet: SearchSnippet | string | undefined }) {
  // What the server sends is not trusted to have the shape: a string (the older form of the answer, with its own tags) is drawn as the text it is, tags and all, and anything else with no text is nothing.
  if (typeof snippet === 'string') return <>{snippet}</>;
  const text = typeof snippet?.text === 'string' ? snippet.text : '';
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of usableRanges(text, snippet?.ranges)) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
