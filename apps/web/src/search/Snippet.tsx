import type { ReactNode } from 'react';
import type { SearchSnippet } from './types';

/**
 * The ranges that can be drawn: whole numbers, inside the text, in order, not overlapping. A range that is none of these is ignored (the server promises it never sends one; a client does not
 * trust that with text it is about to draw).
 */
export function usableRanges(text: string, ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = ranges.filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length).toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const kept: [number, number][] = [];
  for (const [start, end] of sorted) if (kept.length === 0 || start >= kept[kept.length - 1]![1]) kept.push([start, end]);
  return kept;
}

/** The snippet as text, with `mark` around the matched words. The text goes to the page as text (React escapes it): no markup of it is ever read, whatever it holds. */
export function Snippet({ snippet }: { readonly snippet: SearchSnippet }) {
  const { text } = snippet;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of usableRanges(text, snippet.ranges)) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
