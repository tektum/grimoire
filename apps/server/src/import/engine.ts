import { duplicateIndexes, isBadName, reportedName } from '@tektum/grimoire-core/import/checks';
import { isIgnoredEntry } from '@tektum/grimoire-core/import/types';
import type { ImportRepo, NewImportItem } from '@tektum/grimoire-core/ports/import-repo';
import type { ImportProfile } from './profile.js';

/** What pass one reads of an entry of the archive: its place in the central directory, its name, and whether it is a directory. */
export interface PassOneEntry {
  readonly index: number;
  readonly path: string;
  /** False when the name is not valid UTF-8. */
  readonly nameValid: boolean;
  readonly isDirectory: boolean;
}

export interface PassOneOptions {
  readonly profile: ImportProfile;
  /** `GRIMOIRE_IMPORT_ALLOW_NESTED_ZIPS`: a nested archive is an attachment candidate instead of a skip. */
  readonly allowNestedZips: boolean;
  /** The most pages a collection holds (R10.15). */
  readonly maxPages: number;
}

export type PassOneResult =
  | { readonly ok: true; readonly pagesTotal: number; readonly attachments: number; readonly skipped: number; readonly failed: number }
  /** The archive has more pages than a collection holds, containers included: nothing was added. */
  | { readonly ok: false; readonly reason: 'collection_full'; readonly pagesTotal: number };

/** Items are added in batches of this many (contracts section 4, stage 3). */
const BATCH = 500;
/** What is left of a bad name to report it, before the entry's index is added. */
const BAD_NAME_ROOM = 280;

const canonical = (path: string): string => path.split('/').filter((s) => s !== '' && s !== '.').join('/');

/**
 * Pass one (M7 contracts section 4, stage 3): every entry of the archive becomes one item, once. An ignored entry (a folder, macOS litter) is `skipped` as `ignored`; a name that is
 * not valid UTF-8 or has a control character is `failed` as `bad_name`, stored under its cleaned name and the entry's index so that two such names never share a row; the later of two
 * paths that are the same once NFC-normalised and lower-cased is `skipped` as `duplicate_path`; a nested archive is `skipped` as `nested_archive` unless allowed. The rest are
 * classified by the profile and added `pending`, and a page gets its page id and URL id as it is added.
 *
 * A folder whose pages have no page of its own (`profile.folderPathOf`) becomes an empty container page, `<folder>/`, so that every page has a place in the tree. The directory entry
 * of such a folder is that container, not an ignored row beside it. An archive with more pages than a collection holds (R10.15, the containers counted) is refused before anything
 * is added; a collection that is already part full is a matter for each write (`collection_full` from `writePage`). Running it again adds nothing: every path is there already.
 */
export async function passOne(repo: ImportRepo, tenantId: string, importId: string, entries: readonly PassOneEntry[], options: PassOneOptions): Promise<PassOneResult> {
  const { profile } = options;
  const duplicates = duplicateIndexes(entries.map((e) => e.path));
  const lowerPaths: ReadonlySet<string> = new Set(entries.map((e) => canonical(e.path).normalize('NFC').toLowerCase()));

  const rows: NewImportItem[] = [];
  const pagePaths: string[] = [];
  entries.forEach((e, at) => {
    if (!e.nameValid || isBadName(e.path)) { rows.push({ path: `${reportedName(e.path).slice(0, BAD_NAME_ROOM)} [entry ${String(e.index)}]`, kind: 'other', status: 'failed', message: 'bad_name' }); return; }
    if (duplicates.has(at)) { rows.push({ path: `${e.path} [entry ${String(e.index)}]`, kind: 'other', status: 'skipped', message: 'duplicate_path' }); return; }
    if (isIgnoredEntry(e.path, e.isDirectory)) { rows.push({ path: e.path, kind: 'other', status: 'skipped', message: 'ignored' }); return; }
    if (/\.zip$/i.test(e.path) && !options.allowNestedZips) { rows.push({ path: e.path, kind: 'other', status: 'skipped', message: 'nested_archive' }); return; }
    const kind = profile.classify({ path: e.path });
    rows.push({ path: e.path, kind });
    if (kind === 'page') pagePaths.push(e.path);
  });

  // The folders that have a page of their own, and the folders above pages that have none: those get a container.
  const hasPage = new Set(pagePaths.map((p) => profile.folderPathOf(p, lowerPaths)).filter((f): f is string => f !== undefined));
  const containers = new Set<string>();
  for (const path of pagePaths) {
    for (let folder = profile.parentPathOf(path, lowerPaths); folder !== null && !hasPage.has(folder) && !containers.has(folder); ) {
      containers.add(folder);
      const above = folder.split('/').slice(0, -1).join('/');
      folder = above === '' ? null : above;
    }
  }
  const containerPaths = new Set([...containers].map((f) => `${f}/`));
  const pagesTotal = pagePaths.length + containers.size;
  if (pagesTotal > options.maxPages) return { ok: false, reason: 'collection_full', pagesTotal };

  const kept = rows.filter((r) => !(r.status === 'skipped' && r.message === 'ignored' && containerPaths.has(canonical(r.path) === '' ? r.path : `${canonical(r.path)}/`)));
  const all = [...kept, ...[...containerPaths].map((path): NewImportItem => ({ path, kind: 'page' }))];
  for (let from = 0; from < all.length; from += BATCH) await repo.addItems(tenantId, importId, all.slice(from, from + BATCH));

  return {
    ok: true, pagesTotal,
    attachments: all.filter((r) => r.kind === 'attachment' && r.status === undefined).length,
    skipped: all.filter((r) => r.status === 'skipped').length,
    failed: all.filter((r) => r.status === 'failed').length,
  };
}
