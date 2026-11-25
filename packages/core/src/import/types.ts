/** What an entry of an import archive is, decided in pass one (contracts section 4). */
export type ItemKind = 'page' | 'attachment' | 'database_csv' | 'other';

/** Why an entry was not imported: `skipped` for the first four, `failed` for the others (the report says which). */
export type ItemReason =
  | 'ignored' | 'duplicate_path' | 'nested_archive' | 'too_large' | 'entry_too_large'
  | 'bad_name' | 'size_mismatch' | 'invalid_encoding';

/** Entries that are never imported and are not worth a line in the report's failures: a folder, macOS resource forks, Finder and Explorer litter. */
export function isIgnoredEntry(path: string, isDirectory: boolean): boolean {
  if (isDirectory || path.endsWith('/')) return true;
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';
  return segments[0] === '__MACOSX' || name === '.DS_Store' || name === 'Thumbs.db';
}
