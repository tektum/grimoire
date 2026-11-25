import type { ImportState } from '../../import/types';
import { percent, stateLine } from './messages';

/** Where an import is: a progress bar with its value, and the line that says it in words. */
export function Progress({ state }: { readonly state: ImportState }) {
  const value = percent(state.counts);
  return (
    <div className="import-progress">
      <div className="import-bar" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={`${String(value)} percent`}>
        <div className="import-bar-fill" style={{ inlineSize: `${String(value)}%` }} />
      </div>
      <p role="status">{stateLine(state)}</p>
    </div>
  );
}
