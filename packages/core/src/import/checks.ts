import type { ImportConfig } from '../ports/config.js';

/** What the central directory of an archive says about one entry. No file name is ever logged or put in a refusal: a refusal names the entry's index. */
export interface ArchiveEntry {
  readonly path: string;
  /** The uncompressed size the entry declares (it is checked against the bytes really read). */
  readonly size: number;
  readonly compressedSize: number;
  readonly isSymlink: boolean;
  readonly isDirectory: boolean;
  /** A plain file (not a device, a pipe, a socket or a link). A directory is not regular and is not refused for it. */
  readonly isRegular: boolean;
}

export type HeaderRefusal = 'unsafe_path' | 'symlink' | 'non_regular' | 'too_many_entries' | 'too_large' | 'ratio';
export type HeaderCheck = { readonly ok: true } | { readonly ok: false; readonly reason: HeaderRefusal; readonly index?: number };

/** The longest entry path kept, in characters. A Notion export puts a 32-character id in every segment and nests as deep as the page tree allows, which stays well under this. */
export const MAX_ENTRY_PATH_LENGTH = 4096;
/** The longest a reported name is, in characters. */
export const MAX_REPORTED_NAME_LENGTH = 300;
// eslint-disable-next-line no-control-regex -- the point is to find them: C0, DEL, C1, and the line and paragraph separators
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex -- the point is to remove them
const CONTROL_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * A name that cannot be kept and shown as it is: a control character or a line separator, or a path longer than `MAX_ENTRY_PATH_LENGTH`. It is one failed item
 * (`bad_name`), never a refused archive: an odd name in a large export must not lose the import. The item is stored under `reportedName`, because it is never looked up as an entry.
 */
export const isBadName = (path: string): boolean => path.length > MAX_ENTRY_PATH_LENGTH || CONTROL.test(path);

/** What is kept of a bad name to report it: control characters removed, at most `MAX_REPORTED_NAME_LENGTH` characters. */
export const reportedName = (path: string): string => path.replace(CONTROL_GLOBAL, '').slice(0, MAX_REPORTED_NAME_LENGTH);

/** A name that could write outside the import: a `..` segment, an absolute path, a drive letter, a backslash or a NUL. Those are attacks, and they refuse the whole archive. */
function unsafe(path: string): boolean {
  return path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..');
}

/**
 * The header check of stage 2, over the metadata alone (R10.3): nothing of the archive has been read. The count is judged first, so a hundred thousand entries cost one
 * comparison; then each entry's name and type; then the declared total, the ratio of the whole archive, and the ratio of each entry. A ratio of exactly the limit passes.
 */
export function checkHeader(entries: readonly ArchiveEntry[], archiveBytes: number, limits: Pick<ImportConfig, 'maxEntries' | 'maxUncompressedBytes' | 'maxRatio'>): HeaderCheck {
  if (entries.length > limits.maxEntries) return { ok: false, reason: 'too_many_entries' };
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    if (unsafe(entry.path)) return { ok: false, reason: 'unsafe_path', index };
    if (entry.isSymlink) return { ok: false, reason: 'symlink', index };
    if (!entry.isRegular && !entry.isDirectory) return { ok: false, reason: 'non_regular', index };
    total += entry.size;
  }
  if (total > limits.maxUncompressedBytes) return { ok: false, reason: 'too_large' };
  if (total > limits.maxRatio * archiveBytes) return { ok: false, reason: 'ratio' };
  for (const [index, entry] of entries.entries()) {
    if (entry.size > limits.maxRatio * entry.compressedSize) return { ok: false, reason: 'ratio', index };
  }
  return { ok: true };
}

/** The indexes of the entries whose path equals an earlier one once NFC-normalised, lower-cased and cleared of `.` and empty segments (the later one is the duplicate). */
export function duplicateIndexes(paths: readonly string[]): ReadonlySet<number> {
  const seen = new Set<string>();
  const out = new Set<number>();
  for (const [index, path] of paths.entries()) {
    // `.` and empty segments name the same file as the path without them, as a link resolves it.
    const key = path.normalize('NFC').toLowerCase().split('/').filter((segment) => segment !== '' && segment !== '.').join('/');
    if (seen.has(key)) out.add(index);
    else seen.add(key);
  }
  return out;
}
