import { ImportError } from '../../import/api';
import type { ImportItem, ImportState } from '../../import/types';

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

/** The share of the pages handled (imported, skipped or failed), a whole number from 0 to 100 (0 while the count of pages is not known). */
export function percent(counts: ImportState['counts']): number {
  if (counts.pagesTotal <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(((counts.pagesDone + counts.skipped + counts.failed) / counts.pagesTotal) * 100)));
}

/** What the bar shows: full for an import that is done (every page was handled, one way or another), how far it got for the others. */
export const barValue = (state: ImportState): number => (state.status === 'done' ? 100 : percent(state.counts));

const FALLBACK: Record<'skipped' | 'failed', string> = { skipped: 'The file was left out.', failed: 'The file could not be imported.' };
const CODE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+/;
const CODE_WORDS: Record<string, string> = {
  too_large: 'The page is larger than the limit for a page.',
  'tenant-pages-full': 'The workspace has reached its limit of pages.',
  'tenant-storage-full': 'The workspace has run out of storage.',
  collection_full: 'The collection is full.',
};

/**
 * The reason a file was skipped or failed, in words. The server's message is text for people and may start with the code of the reason ("too_large: The page is larger than..."): the code is left out,
 * and the words after it (which name the limit, as the server has it) are kept. A message that is only a code has words of its own here; a code this screen does not know and a missing message have
 * the words of the status. A code is never shown.
 */
export function reasonText(item: Pick<ImportItem, 'status' | 'message'>): string | null {
  if (item.status === 'imported') return item.message;
  const message = item.message?.trim() ?? '';
  const code = CODE.exec(message)?.[0];
  if (code === undefined) return message === '' ? FALLBACK[item.status] : message;
  const rest = message
    .slice(code.length)
    .replace(/^\s*:\s*/, '')
    .trim();
  if (rest !== '' && !CODE.test(rest)) return rest;
  return CODE_WORDS[code] ?? FALLBACK[item.status];
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
