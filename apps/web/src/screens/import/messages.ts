import { ImportError } from '../../import/api';
import { formatBytes } from '../../editor/attachments/limits';
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

/** What the server announces (`GET /v1/config`) that a reason names; each is absent when it is not known. */
export interface ImportLimits {
  readonly markdownBytes?: number;
  readonly entryBytes?: number;
}

const positive = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** The limits of a client configuration: the largest page's Markdown (`maxMarkdownBytes`) and the largest file (`maxAttachmentBytes`). */
export function importLimitsOf(config: unknown): ImportLimits {
  const c = (typeof config === 'object' && config !== null ? config : {}) as Record<string, unknown>;
  const markdownBytes = positive(c['maxMarkdownBytes']);
  const entryBytes = positive(c['maxAttachmentBytes']);
  return { ...(markdownBytes === undefined ? {} : { markdownBytes }), ...(entryBytes === undefined ? {} : { entryBytes }) };
}

const limit = (what: string, bytes: number | undefined, nameless: string): string =>
  bytes === undefined ? `The ${what} is larger than the limit for a ${nameless}.` : `The ${what} is larger than the limit of ${formatBytes(bytes)}.`;

/** The sentence for each reason code the import pipeline gives (a skipped or failed file's `message` is exactly one of these, and never a path). */
const WORDS: Record<string, (l: ImportLimits) => string> = {
  ignored: () => 'The import leaves this kind of file out on purpose.',
  duplicate_path: () => 'Another file in the zip has the same path.',
  too_large: (l) => limit('page', l.markdownBytes, 'page'),
  entry_too_large: (l) => limit('file', l.entryBytes, 'file'),
  type_not_allowed: () => 'This type of file is not allowed.',
  type_mismatch: () => 'The content of the file does not match its type.',
  unreferenced: () => 'No page uses this file.',
  nested_archive: () => 'A zip inside the zip is not imported.',
  empty: () => 'The file is empty.',
  bad_name: () => 'The name of the file cannot be used.',
  invalid_encoding: () => 'The file is not valid text.',
  size_mismatch: () => 'The size of the file is not what the zip said.',
  'invalid-markdown': () => 'The Markdown could not be read.',
  timeout: () => 'Converting the file took too long.',
  'out-of-memory': () => 'The file was too big to convert.',
  state_too_large: (l) => limit('converted page', l.markdownBytes, 'page'),
  'content-lost': () => 'Part of the content could not be kept.',
  convert_failed: () => 'The file could not be converted.',
  collection_full: () => 'The collection is full.',
  internal: () => 'Something went wrong on our side with this file.',
};

/**
 * The reason a file was skipped or failed, in words. The server's `message` is the code of the reason: the screen has the sentence for each code and takes the limit a code names from the
 * server's configuration. A code it does not know, no message, and anything that is not a code (a text is never shown) have the generic sentence of the status.
 */
export function reasonText(item: Pick<ImportItem, 'status' | 'message'>, limits: ImportLimits): string | null {
  if (item.status === 'imported') return null;
  const words = item.message === null || !Object.hasOwn(WORDS, item.message) ? undefined : WORDS[item.message];
  return words === undefined ? FALLBACK[item.status] : words(limits);
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
