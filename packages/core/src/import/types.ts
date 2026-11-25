/** What an entry of an import archive is, decided in pass one (contracts section 4). */
export type ItemKind = 'page' | 'attachment' | 'database_csv' | 'other';

/** Why an entry was not imported. */
export type ItemReason =
  | 'ignored' | 'duplicate_path' | 'nested_archive' | 'too_large' | 'entry_too_large'
  | 'bad_name' | 'size_mismatch' | 'invalid_encoding';

/**
 * What the report calls each reason: the first five are `skipped` (left out on purpose, or by a limit), the last three are `failed` (the entry could not be read as it is). A
 * record, so that a reason added to `ItemReason` without a fate does not compile.
 */
export const ITEM_FATE: Readonly<Record<ItemReason, 'skipped' | 'failed'>> = {
  ignored: 'skipped', duplicate_path: 'skipped', nested_archive: 'skipped', too_large: 'skipped', entry_too_large: 'skipped',
  bad_name: 'failed', size_mismatch: 'failed', invalid_encoding: 'failed',
};

/** Entries that are never imported and are not worth a line in the report's failures: a folder, macOS resource forks, Finder and Explorer litter. */
export function isIgnoredEntry(path: string, isDirectory: boolean): boolean {
  if (isDirectory || path.endsWith('/')) return true;
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';
  return segments[0] === '__MACOSX' || name === '.DS_Store' || name === 'Thumbs.db';
}
