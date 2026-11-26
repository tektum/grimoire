import { ImportError } from '../../import/api';
import { formatBytes } from '../../editor/attachments/limits';
import type { ImportItem, ImportState } from '../../import/types';

/** What to do with an export that is larger than an import can take: what makes an export large is its big files, and the largest of them could not be imported anyway. */
const SMALLER = 'Zip the export again without its big files, such as videos, and import that.';

/** Notion names each file of an export that it splits `<name>-Part-<n>.zip`; one part alone is not an export. Said before the upload, from the name only: the person can still go on. */
export const isPartOfSplitExport = (fileName: string): boolean => /-part-\d+\.zip$/i.test(fileName);
export const SPLIT_EXPORT_NOTE =
  'This looks like one part of an export split into parts. An import takes the whole export in one zip: unzip the parts into one folder, zip that folder without its big files (such as videos), and import that.';

/** The plain words, with what to do, for an import that failed on the shape or the size of its zip; every other code is shown as a code. */
const FAILED_WORDS: Readonly<Record<string, string>> = {
  nested_or_split_export: 'The import failed: this zip holds other zips, the way an export in parts does. Unzip the parts into one folder, zip that folder, and import it.',
  too_large: `The import failed: the zip holds more than an import can take. ${SMALLER}`,
};

/** What the person is told when a step of starting an import is refused. */
export function refusal(error: unknown): string {
  if (!(error instanceof ImportError)) return 'The import could not be started. Try again.';
  if (error.step === 'create') {
    if (error.status === 413) return `That file is larger than an import can take. ${SMALLER}`;
    if (error.status === 404) return 'That collection can’t be found.';
    if (error.status === 403) return 'You can’t import into that collection.';
    if (error.status === 422) return 'That file can’t be imported.';
    if (error.status === 429) return 'Too many imports were started. Try again in a while.';
  }
  if (error.step === 'upload') return 'The file could not be sent. Try again.';
  if (error.step === 'start') {
    if (error.code === 'upload_missing') return 'The file did not arrive. Try again.';
    if (error.code === 'not_a_zip') return 'That is not a zip file.';
    if (error.code === 'size_mismatch') return 'The file that arrived is not the size it was said to be. Try again.';
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
  'too-large': (l) => limit('page', l.markdownBytes, 'page'), // the spelling of the Markdown seed
  'too-deep': () => 'The page has too many levels.',
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
  // The converted page is over its own cap (its state, not its Markdown): the Markdown cap is another number, so none is named.
  state_too_large: () => limit('converted page', undefined, 'page'),
  'content-lost': () => 'Part of the content could not be kept.',
  convert_failed: () => 'The file could not be converted.',
  collection_full: () => 'The collection is full.',
  internal: () => 'Something went wrong on our side with this file.',
  // A database (its CSV): a row that is only in its table, and a table that could not become a page.
  database_row: () => 'This row only repeats what its table shows: it is in the table, not a page of its own.',
  table_too_large: (l) =>
    `The table is too large for one page: more than 1,000 rows, or ${l.markdownBytes === undefined ? 'larger than the limit for a page' : `more than ${formatBytes(l.markdownBytes)}`} as a table.`,
  csv_malformed: () => 'The table could not be read.',
  csv_field_too_large: () => 'A cell of the table is too large.',
};

/**
 * The reason a file was skipped or failed, in words. The server's `message` is the code of the reason: the screen has the sentence for each code and takes the limit a code names from the
 * server's configuration. A code it does not know, no message, and anything that is not a code (a text is never shown) have the generic sentence of the status.
 */
export function reasonText(item: Pick<ImportItem, 'status' | 'message'>, limits: ImportLimits): string | null {
  if (item.status === 'ok') return null;
  const words = item.message === null || !Object.hasOwn(WORDS, item.message) ? undefined : WORDS[item.message];
  return words === undefined ? FALLBACK[item.status] : words(limits);
}

const was = (n: number): string => (n === 1 ? 'was' : 'were');
/** What a reason code of a picture from the web that was not copied says, for `n` pictures. The order is the order of this table; a code it does not know comes last. */
const IMAGE_WORDS: Readonly<Record<string, (n: number) => string>> = {
  blocked_address: (n) => `${String(n)} ${was(n)} at an address this tool may not fetch from`,
  redirect: (n) => `${String(n)} ${was(n)} redirected too many times, or in a circle`,
  too_large: (n) => `${String(n)} ${was(n)} too large`,
  timeout: (n) => `${String(n)} took too long to answer`,
  status: (n) => `${String(n)} could not be fetched: the address did not return the picture`,
  type: (n) => `${String(n)} ${was(n)} not a picture of a type that is accepted, or not the type their address said`,
  budget: (n) => `${String(n)} ${was(n)} left out because the import had reached its limit for pictures from the web`,
  network: (n) => `${String(n)} could not be reached`,
  scheme: (n) => `${String(n)} ${was(n)} at an address this tool does not accept (only https on the standard port, with no password in it)`,
  not_fetched: (n) => `${String(n)} ${was(n)} not fetched because fetching pictures from the web is switched off`,
  empty: (n) => `${String(n)} ${was(n)} empty`,
  size_mismatch: (n) => `${String(n)} could not be stored: a copy kept from an earlier attempt did not match`,
};
/** A reason code is lower-case words with underscores; anything else (a key that could carry an address) is not a reason and is not shown. */
const REASON_CODE = /^[a-z][a-z_]{0,31}$/;

/** The sentence for the pictures from the web of one page that were not copied, or null when there are none. Never an address: the server sends codes and counts only, and a key that is not a code is dropped. */
export function remoteImageText(failures: Readonly<Record<string, number>> | undefined): string | null {
  const entries = Object.entries(failures ?? {}).filter(([code, n]) => REASON_CODE.test(code) && Number.isSafeInteger(n) && n > 0);
  if (entries.length === 0) return null;
  const known = Object.keys(IMAGE_WORDS).flatMap((code) => entries.filter(([c]) => c === code));
  const unknown = entries.filter(([c]) => !Object.hasOwn(IMAGE_WORDS, c));
  const parts = [...known.map(([c, n]) => (IMAGE_WORDS[c] as (n: number) => string)(n)), ...unknown.map(([, n]) => `${String(n)} for a reason this version of the screen does not know`)];
  return `Pictures from the web that were not copied: ${parts.join(', ')}.`;
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
    case 'failed': {
      // Both end before any page is made, so there is nothing in the trash to mention.
      const words = state.error === null || !Object.hasOwn(FAILED_WORDS, state.error) ? undefined : FAILED_WORDS[state.error];
      return words ?? `The import failed${state.error === null ? '' : ` (${state.error})`}. The pages it created were moved to the trash.`;
    }
    case 'cancelled':
      return 'Cancelled. The pages it created were moved to the trash.';
  }
}
