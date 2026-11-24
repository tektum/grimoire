import { diffLines } from 'diff';
import { useMemo } from 'react';
import './history.css';

/** The lines of one part of a diff, without the empty piece after the last line break. */
const linesOf = (value: string): string[] => {
  const lines = value.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/**
 * A line diff from `from` to `to` (R9.4): an `ins` element for each added line, a `del` element for each removed line, and plain lines for the rest. Each line is
 * text, never markup, and says Added or Removed in words as well as by its mark.
 */
export function DiffView({ from, to }: { readonly from: string; readonly to: string }) {
  const parts = useMemo(() => diffLines(from, to), [from, to]);
  if (parts.every((p) => p.added !== true && p.removed !== true)) return <p>The page is the same as this version.</p>;
  let key = 0;
  return (
    <div className="history-diff" role="group" aria-label="Changes">
      {parts.flatMap((part) =>
        linesOf(part.value).map((line) => {
          key += 1;
          if (part.added === true)
            return (
              <ins key={key} className="history-line">
                <span className="history-hidden">Added: </span>
                <span aria-hidden="true" className="history-mark">+</span>
                <span data-text>{line}</span>
              </ins>
            );
          if (part.removed === true)
            return (
              <del key={key} className="history-line">
                <span className="history-hidden">Removed: </span>
                <span aria-hidden="true" className="history-mark">&minus;</span>
                <span data-text>{line}</span>
              </del>
            );
          return (
            <div key={key} className="history-line" data-line="same">
              <span aria-hidden="true" className="history-mark" />
              <span data-text>{line}</span>
            </div>
          );
        }),
      )}
    </div>
  );
}
