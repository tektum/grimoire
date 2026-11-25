import { ImportError } from '../../import/api';
import type { ImportState } from '../../import/types';

/** What the person is told when a step of starting an import is refused. */
export function refusal(error: unknown): string {
  if (!(error instanceof ImportError)) return 'The import could not be started. Try again.';
  if (error.step === 'create') {
    if (error.status === 413) return 'That file is larger than an import may be.';
    if (error.status === 404) return 'That collection can’t be found.';
    if (error.status === 403) return 'You can’t import into that collection.';
    if (error.status === 422) return 'That file can’t be imported.';
    if (error.status === 429) return 'Too many imports were started. Try again in a while.';
  }
  if (error.step === 'upload') return 'The file could not be sent. Try again.';
  if (error.step === 'start') {
    if (error.code === 'upload_missing') return 'The file did not arrive. Try again.';
    if (error.code === 'not_a_zip') return 'That is not a zip file.';
  }
  return 'The import could not be started. Try again.';
}

/** The share of the pages done, a whole number from 0 to 100 (0 while the count of pages is not known). */
export function percent(counts: ImportState['counts']): number {
  if (counts.pagesTotal <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((counts.pagesDone / counts.pagesTotal) * 100)));
}

const pages = (n: number): string => `${String(n)} ${n === 1 ? 'page' : 'pages'}`;

/** The one line that says where an import is. */
export function stateLine(state: ImportState): string {
  const { counts } = state;
  switch (state.status) {
    case 'created':
    case 'uploaded':
      return 'Waiting to start…';
    case 'running':
      return counts.pagesTotal > 0 ? `Importing: ${String(counts.pagesDone)} of ${pages(counts.pagesTotal)}` : 'Importing…';
    case 'done': {
      const more = [counts.skipped > 0 ? `${String(counts.skipped)} skipped` : '', counts.failed > 0 ? `${String(counts.failed)} failed` : ''].filter((s) => s !== '');
      return `Done: ${pages(counts.pagesDone)} imported${more.length > 0 ? `, ${more.join(', ')}` : ''}.`;
    }
    case 'failed':
      return `The import failed${state.error === null ? '' : ` (${state.error})`}. The pages it created were moved to the trash.`;
    case 'cancelled':
      return 'Cancelled. The pages it created were moved to the trash.';
  }
}
