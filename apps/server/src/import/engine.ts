import { duplicateIndexes, isBadName, reportedName } from '@tektum/grimoire-core/import/checks';
import { isIgnoredEntry } from '@tektum/grimoire-core/import/types';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import type { ImportConfig } from '@tektum/grimoire-core/ports/config';
import type { ConstructKind, ImportCounts, ImportItem, ImportRecord, ImportRepo, NewImportItem, WriteImportedPageResult } from '@tektum/grimoire-core/ports/import-repo';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import type { TenantPageLimits } from '@tektum/grimoire-core/ports/page-repo';
import type { Ordering } from '@tektum/grimoire-core/tree/position';
import { importFailedKey } from './keys.js';
import { rewriteMarkdown } from './markdown-rewrite.js';
import type { Resolved } from './markdown-rewrite.js';
import { normalizePage } from './normalize.js';
import { createRemoteBudget } from './remote-images/index.js';
import type { RemoteImageFetcher } from './remote-images/index.js';
import { buildLinkIndex } from './link-index.js';
import { readCsv } from './notion/table.js';
import { MAX_TITLE, type ImportProfile, type IndexedItem } from './profile.js';
import { judgeFile, stageAttachment, stageRemoteImage } from './attachments.js';
import type { AttachmentSettings, Rejection, Staged, StagedFile, StageContext } from './attachments.js';
import { readEntry } from './read-entry.js';
import { EntryAbort } from './zip-reader.js';
import type { ZipEntry, ZipReader } from './zip-reader.js';

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
  /** A page's text by its path (`pageText`), for the few pages that claim one folder (decision 171); without it such a folder stays a container. */
  readonly read?: (path: string) => Promise<string | undefined>;
}

export type PassOneResult =
  | { readonly ok: true; readonly pagesTotal: number; readonly attachments: number; readonly skipped: number; readonly failed: number }
  /**
   * Nothing was added: the archive has more pages than a collection holds, containers included (`collection_full`), or it has no page and holds other zips, the way an export in parts
   * zipped once more does (`nested_or_split_export`: the person unzips the parts into one folder and zips that).
   */
  | { readonly ok: false; readonly reason: 'collection_full' | 'nested_or_split_export'; readonly pagesTotal: number };

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
  // Only files can be a folder's page: a directory entry named `index.md/` is not an index file.
  const lowerPaths: ReadonlySet<string> = new Set(entries.filter((e) => !e.isDirectory && !e.path.endsWith('/')).map((e) => canonical(e.path).normalize('NFC').toLowerCase()));
  // Generated rows (a bad name, a duplicate) take a path no real entry has: the suffix grows until the path is free.
  const taken = new Set(entries.map((e) => e.path));
  const free = (base: string, index: number): string => {
    let path = `${base} [entry ${String(index)}]`;
    for (let n = 2; taken.has(path); n++) path = `${base} [entry ${String(index)}.${String(n)}]`;
    taken.add(path);
    return path;
  };

  const rows: NewImportItem[] = [];
  const pagePaths: string[] = [];
  entries.forEach((e, at) => {
    if (!e.nameValid || isBadName(e.path)) { rows.push({ path: free(reportedName(e.path).slice(0, BAD_NAME_ROOM).replace(/[\uD800-\uDBFF]$/, ''), e.index), kind: 'other', status: 'failed', message: 'bad_name' }); return; }
    if (duplicates.has(at)) { rows.push({ path: free(e.path, e.index), kind: 'other', status: 'skipped', message: 'duplicate_path' }); return; }
    if (isIgnoredEntry(e.path, e.isDirectory)) { rows.push({ path: e.path, kind: 'other', status: 'skipped', message: 'ignored' }); return; }
    if (/\.zip$/i.test(e.path) && !options.allowNestedZips) { rows.push({ path: e.path, kind: 'other', status: 'skipped', message: 'nested_archive' }); return; }
    const kind = profile.classify({ path: e.path }, lowerPaths);
    rows.push({ path: e.path, kind });
    if (kind === 'page' || kind === 'database_csv') pagePaths.push(e.path);
  });

  // What pass one kept, not the raw entries: a zip it set apart (macOS litter, a bad name, a duplicate) says nothing about the archive.
  const nestedZips = rows.some((r) => r.message === 'nested_archive' || (r.status === undefined && r.kind === 'attachment' && /\.zip$/i.test(r.path)));
  if (pagePaths.length === 0 && nestedZips) return { ok: false, reason: 'nested_or_split_export', pagesTotal: 0 };

  // The folders that have a page of their own, and the folders above pages that have none: those get a container. Folders are the same folder by the key duplicate detection uses (NFC,
  // lower case, `.` and empty segments dropped), so `Dir` and `dir` are one; a container keeps the spelling it was first seen under.
  const key = (folder: string): string => canonical(folder).normalize('NFC').toLowerCase();
  // A folder that a page and a database of its name share has owners too: its pages go under one or the other (pass two, decision 167).
  const shared = profile.sharedFoldersOf?.(pagePaths, lowerPaths)?.keys() ?? [];
  const owners = options.read === undefined ? new Map<string, string>() : await folderOwners(profile, rows, pagePaths, lowerPaths, options.read);
  const hasPage = new Set([...pagePaths.map((p) => profile.folderPathOf(p, lowerPaths)).filter((f): f is string => f !== undefined).map(key), ...shared, ...owners.keys()]);
  const containers = new Map<string, string>();
  for (const path of pagePaths) {
    for (let folder = profile.parentPathOf(path, lowerPaths); folder !== null && !hasPage.has(key(folder)) && !containers.has(key(folder)); ) {
      containers.set(key(folder), canonical(folder));
      const above = canonical(folder).split('/').slice(0, -1).join('/');
      folder = above === '' ? null : above;
    }
  }
  const containerPaths = new Set([...containers.values()].map((f) => `${f}/`));
  const pagesTotal = pagePaths.length + containers.size;
  if (pagesTotal > options.maxPages) return { ok: false, reason: 'collection_full', pagesTotal };

  const containerKeys = new Set(containers.keys());
  const kept = rows.filter((r) => !(r.status === 'skipped' && r.message === 'ignored' && containerKeys.has(key(r.path))));
  const all = [...kept, ...[...containerPaths].map((path): NewImportItem => ({ path, kind: 'page' }))];
  for (let from = 0; from < all.length; from += BATCH) await repo.addItems(tenantId, importId, all.slice(from, from + BATCH));

  return {
    ok: true, pagesTotal,
    attachments: all.filter((r) => r.kind === 'attachment' && r.status === undefined).length,
    skipped: all.filter((r) => r.status === 'skipped').length,
    failed: all.filter((r) => r.status === 'failed').length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Pass two (M7 contracts section 4, stage 4, without the attachments of 4d)

export interface PassTwoDeps {
  readonly repo: ImportRepo;
  readonly files: FileStorage;
  readonly converter: MarkdownConverter;
  readonly profile: ImportProfile;
  readonly ordering: Pick<Ordering, 'between'>;
  readonly reader: Pick<ZipReader, 'openEntry'>;
  /** The files setting and the type sniffer: absent, the files a page uses stay as written. */
  readonly attachments?: AttachmentSettings;
  /** Remote images (M7 contracts section 5). Absent: they are not looked at. Present with no fetcher (fetching is switched off): they stay links and are counted as warnings. */
  readonly remote?: { readonly fetcher: RemoteImageFetcher | undefined; readonly config: ImportConfig['remote'] };
  /** The entries of the archive, as `openArchive` read them. */
  readonly entries: readonly ZipEntry[];
  /** `maxTableBytes`: the largest Markdown table a database becomes (`GRIMOIRE_IMPORT_MAX_TABLE_BYTES`, the contract's default when absent). */
  readonly limits: {
    readonly maxEntryBytes: number; readonly maxRatio: number; readonly seedMaxMarkdownBytes: number; readonly maxStateBytes: number; readonly maxTableBytes?: number;
    /**
     * The most bytes of copies of files the import may make (a page that links a file gets a copy of its own, so a file that many pages link is many copies): past it the import stops
     * (`attachment_budget`). Counted from the pages already written, so a resumed run does not start from zero. Absent: no budget.
     */
    readonly maxCopiedBytes?: number;
  };
  readonly pageLimits: TenantPageLimits;
  readonly now: () => number;
}

export interface PassTwoOptions {
  /** Pages per batch (default 25). */
  readonly batchPages?: number;
  /** Bytes of Markdown per batch (default 8 MiB). */
  readonly batchBytes?: number;
  readonly signal?: AbortSignal;
}

export type PassTwoStop = 'not_running' | 'aborted' | 'collection_deleted' | 'attachment_budget';
export type PassTwoResult =
  | { readonly kind: 'done'; readonly counts: ImportCounts }
  /** The run ended before every page was dealt with; what was done is kept, and the counts say so. */
  | { readonly kind: 'stopped'; readonly reason: PassTwoStop; readonly counts: ImportCounts }
  /** The converter is busy: the item is still pending and the caller tries again later. */
  | { readonly kind: 'busy'; readonly counts: ImportCounts };

const DEFAULT_BATCH_PAGES = 25;
const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * The page of each folder that several pages could stand for (`profile.claimantsOf`), by the folder's key: the one of them whose text, as the profile cleans it, links to
 * something in the folder (decision 171). With none, or several, the folder has no page of its own and stays a container. Both passes read it the same way, so they agree.
 */
async function folderOwners(profile: ImportProfile, files: readonly { readonly path: string; readonly kind: string }[], pagePaths: readonly string[], lowerPaths: ReadonlySet<string>, read: (path: string) => Promise<string | undefined>): Promise<ReadonlyMap<string, string>> {
  const owners = new Map<string, string>();
  const claimants = profile.claimantsOf?.(pagePaths, lowerPaths);
  if (claimants === undefined || claimants.size === 0) return owners;
  // The archive's files by path: a link found here names the path it points at.
  const index = buildLinkIndex(files.filter((f) => f.kind === 'page' || f.kind === 'database_csv' || f.kind === 'attachment').map((f): IndexedItem => ({ itemId: f.path, path: f.path, kind: f.kind === 'attachment' ? 'attachment' : 'page' })), profile.idOf?.bind(profile));
  for (const [folder, paths] of claimants) {
    const linking: string[] = [];
    for (const path of paths) {
      const text = await read(path);
      if (text === undefined) continue;
      let into = false;
      rewriteMarkdown(profile.preprocess(text, { path }), (target) => {
        const found = profile.resolveLink(target, path, index);
        if (found !== undefined && folderKey(found.itemId).startsWith(`${folder}/`)) into = true;
        return undefined;
      });
      if (into) linking.push(path);
    }
    if (linking.length === 1) owners.set(folder, linking[0] as string);
  }
  return owners;
}

/** The contract's largest table (`GRIMOIRE_IMPORT_MAX_TABLE_BYTES` default) and most rows of a database's table (M7 contracts section 4). */
const MAX_TABLE_BYTES = 262_144;
const MAX_TABLE_ROWS = 1000;
/** The largest record of a database's CSV (contracts section 4: `max_record_size` 1 MiB). */
const MAX_CSV_RECORD_BYTES = 1_048_576;

/**
 * A database's CSV as the Markdown table its page holds (decision 112: a source database is a plain table on a page), or why it cannot be: the CSV cannot be read (`csv_malformed`,
 * `csv_field_too_large`, `invalid_encoding`), or the table is over the caps (`table_too_large`: more than 1,000 rows, or more Markdown than `maxTableBytes` or the seed cap, the lower).
 */
function databaseTable(bytes: Buffer, profile: ImportProfile, maxTableBytes: number): { readonly ok: true; readonly markdown: string } | { readonly ok: false; readonly reason: string } {
  if (profile.csvToMarkdown === undefined) return { ok: false, reason: 'internal' };
  const csv = readCsv(bytes, { maxFieldBytes: MAX_CSV_RECORD_BYTES });
  if (!csv.ok) return { ok: false, reason: csv.reason };
  if (csv.rows.length - 1 > MAX_TABLE_ROWS) return { ok: false, reason: 'table_too_large' };
  const markdown = profile.csvToMarkdown(csv.rows, maxTableBytes);
  return markdown === undefined ? { ok: false, reason: 'table_too_large' } : { ok: true, markdown };
}

/** A page's text by its archive path, read up to the seed cap from the first entry of that path; undefined when it cannot be read or is not UTF-8. */
export function pageText(reader: Pick<ZipReader, 'openEntry'>, limits: { readonly maxEntryBytes: number; readonly maxRatio: number; readonly seedMaxMarkdownBytes: number }, entries: readonly ZipEntry[]): (path: string) => Promise<string | undefined> {
  const byPath = new Map<string, ZipEntry>();
  for (const e of entries) if (!byPath.has(e.path)) byPath.set(e.path, e);
  return async (path) => {
    const entry = byPath.get(path);
    if (entry === undefined) return undefined;
    const read = await readEntry(reader, limits, entry, limits.seedMaxMarkdownBytes);
    if (read.kind !== 'ok') return undefined;
    try { return decoder.decode(read.bytes); } catch { return undefined; }
  };
}

/** A row page that only repeats its row (decision 167): past a `# ` title line, nothing but blank lines and `Column: value` lines of its table's columns. */
function onlyRepeatsRow(text: string, columns: ReadonlySet<string>): boolean {
  const names = [...columns];
  return text.split('\n').every((line, n) => (n === 0 && /^#[ \t]/.test(line)) || line.trim() === '' || names.some((c) => line.startsWith(`${c}:`)));
}
const segmentsOf = (path: string): string[] => path.split('/').filter((s) => s !== '' && s !== '.');
const folderKey = (folder: string): string => segmentsOf(folder).join('/').normalize('NFC').toLowerCase();

const cutTitle = (title: string): { readonly title: string; readonly cut: boolean } => {
  const points = [...title.trim()];
  return points.length <= MAX_TITLE ? { title: points.join(''), cut: false } : { title: points.slice(0, MAX_TITLE).join(''), cut: true };
};

/**
 * Pass two (M7 contracts section 4, stage 4), pages only: each pending page item in tree order (a page after its folder's page, so a child never comes before its parent), read,
 * decoded, cleaned by the profile, its links to other pages rewritten to `/p/<url_id>` (a link that matches nothing stays as written and is a warning; a file the page uses stays
 * as written until the attachments are handled), seeded and converted fail-closed, and written in one transaction under the page id its item was given. A page the converter refuses
 * keeps its original Markdown as an object for the person to download (the report's source), and creates no page. Batches of 25 pages or 8 MiB: before each one the import is read
 * again, and a run that is no longer `running` stops. A failed or skipped parent does not take its children: they go under the nearest page that was written.
 *
 * Known limit: a link to a page that is written later but then fails points at `/p/<url_id>` of a page that does not exist; only links to pages already dealt with are known to be good.
 */
export async function passTwo(deps: PassTwoDeps, record: ImportRecord, options: PassTwoOptions = {}): Promise<PassTwoResult> {
  const { repo, profile } = deps;
  const tenantId = record.tenantId;
  const importId = record.id;
  const batchPages = options.batchPages ?? DEFAULT_BATCH_PAGES;
  const batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;
  // A limit that never lets a batch take an item would loop for ever while the import stays running: a caller's mistake, refused up front.
  if (!Number.isInteger(batchPages) || batchPages < 1) throw new RangeError('batchPages must be a positive integer');
  if (!(batchBytes > 0)) throw new RangeError('batchBytes must be a positive number');
  if (record.createdBy === null) throw new Error('the importer of this import no longer exists');
  const importer = record.createdBy;

  const all: ImportItem[] = [];
  for (let after: string | undefined; ;) {
    const batch = await repo.scanItems(tenantId, importId, after === undefined ? { limit: 1000 } : { limit: 1000, afterId: after });
    if (batch.length === 0) break;
    all.push(...batch);
    after = batch.at(-1)?.id;
  }
  const status = new Map(all.map((i) => [i.id, i.status]));
  // A database becomes a page (its table): it is written in the tree like one.
  const pageItems = all.filter((i) => i.kind === 'page' || i.kind === 'database_csv');
  const isContainer = (i: ImportItem): boolean => i.path.endsWith('/');

  // The link index: files of the archive by their canonical path (NFC, `.` and empty segments dropped), as `resolveLinkPath` makes its targets.
  const index = buildLinkIndex(
    all.filter((i) => (i.kind === 'page' || i.kind === 'database_csv' || i.kind === 'attachment') && !isContainer(i)).map((i): IndexedItem => ({ itemId: i.id, path: i.path, kind: i.kind === 'attachment' ? 'attachment' : 'page' })),
    profile.idOf?.bind(profile),
  );
  const itemById = new Map(all.map((i) => [i.id, i]));
  const lowerPaths: ReadonlySet<string> = new Set(all.filter((i) => !isContainer(i) && i.kind !== 'other').map((i) => segmentsOf(i.path).join('/').normalize('NFC').toLowerCase()));
  // The first entry of a path is the one pass one kept; a later copy was skipped as a duplicate and must not be read in its place.
  const entryByPath = new Map<string, ZipEntry>();
  for (const e of deps.entries) if (!entryByPath.has(e.path)) entryByPath.set(e.path, e);

  // Which page stands for which folder: a folder's own page file, else its container.
  const folderPage = new Map<string, ImportItem>();
  const owners = await folderOwners(profile, all.filter((i) => !isContainer(i)), pageItems.filter((i) => !isContainer(i)).map((i) => i.path), lowerPaths, pageText(deps.reader, deps.limits, deps.entries));
  const pageByPath = new Map(pageItems.map((i) => [i.path, i]));
  for (const [folder, path] of owners) { const owner = pageByPath.get(path); if (owner !== undefined) folderPage.set(folder, owner); }
  for (const i of pageItems) if (!isContainer(i)) { const f = profile.folderPathOf(i.path, lowerPaths); if (f !== undefined && !folderPage.has(folderKey(f))) folderPage.set(folderKey(f), i); }
  for (const i of pageItems) if (isContainer(i) && !folderPage.has(folderKey(i.path))) folderPage.set(folderKey(i.path), i);
  // The most Markdown a database's table may be: the table cap, or the seed cap when that is lower, as the table is seeded like any page (decision 10: the engine checks the cap,
  // the converter never refuses it).
  const tableCap = Math.min(deps.limits.maxTableBytes ?? MAX_TABLE_BYTES, deps.limits.seedMaxMarkdownBytes);
  // A database's table, read once: its columns (the header) and the titles of its rows (the first column).
  const tables = new Map<string, Promise<{ readonly columns: ReadonlySet<string>; readonly titles: ReadonlySet<string> } | undefined>>();
  const tableOf = (db: ImportItem): Promise<{ readonly columns: ReadonlySet<string>; readonly titles: ReadonlySet<string> } | undefined> => {
    let known = tables.get(db.id);
    if (known === undefined) {
      const entry = entryByPath.get(db.path);
      // A CSV too big for any table (below) is not read for its titles either: its database fails, and its rows go under the page beside it.
      known = entry === undefined || entry.size > 4 * tableCap ? Promise.resolve(undefined) : readEntry(deps.reader, deps.limits, entry, deps.limits.maxEntryBytes).then((read) => {
        const csv = read.kind === 'ok' ? readCsv(read.bytes, { maxFieldBytes: MAX_CSV_RECORD_BYTES }) : undefined;
        const [header, ...rows] = csv?.ok === true ? csv.rows : [];
        // In one Unicode form: an export made on one system can spell a title decomposed in a file and composed in its table.
        return header === undefined ? undefined : { columns: new Set(header.map((c) => c.trim().normalize('NFC')).filter((c) => c !== '')), titles: new Set(rows.map((r) => (r[0] ?? '').trim().normalize('NFC'))) };
      });
      tables.set(db.id, known);
    }
    return known;
  };
  const rowText = pageText(deps.reader, deps.limits, deps.entries);
  // Decision 167: a folder that a page and a database of one name share holds the database's rows and the page's own pages: a page of it goes under the database when its title
  // is a row of the table, else under the page. It is read from the archive the same way at every start, so the tree agrees with itself.
  const rowOf = new Map<string, ImportItem>();
  const sharedFolders = profile.sharedFoldersOf?.(pageItems.filter((i) => !isContainer(i)).map((i) => i.path), lowerPaths);
  if (sharedFolders !== undefined && sharedFolders.size > 0) {
    const byPath = new Map(pageItems.map((i) => [i.path, i]));
    // The pages of each shared folder, found once.
    const byFolder = new Map<string, ImportItem[]>();
    for (const i of pageItems) {
      if (isContainer(i) || i.kind !== 'page') continue;
      const folder = folderKey(profile.parentPathOf(i.path, lowerPaths) ?? '');
      if (!sharedFolders.has(folder)) continue;
      const list = byFolder.get(folder);
      if (list === undefined) byFolder.set(folder, [i]); else list.push(i);
    }
    for (const [folder, owners] of sharedFolders) {
      const page = byPath.get(owners.page);
      const db = byPath.get(owners.database);
      if (page === undefined || db === undefined) continue;
      folderPage.set(folder, page);
      const titles = (await tableOf(db))?.titles;
      if (titles === undefined) continue;
      for (const i of byFolder.get(folder) ?? []) {
        const text = await rowText(i.path);
        if (text !== undefined && titles.has(profile.titleOf(i.path, text).trim().normalize('NFC'))) rowOf.set(i.id, db);
      }
    }
  }
  const tableShown = (db: ImportItem): boolean => status.get(db.id) === 'ok' || status.get(db.id) === 'pending';
  const parentOf = (i: ImportItem): ImportItem | undefined => {
    const row = rowOf.get(i.id);
    // A row goes under its database while the table is, or is still to be, written; a database that failed shows no table, so its rows go under the page that shares the
    // folder, as the folder's other pages do (decision 167). The database comes before its rows, so it has settled when a row is written.
    if (row !== undefined && tableShown(row)) return row;
    const folder = isContainer(i) ? segmentsOf(i.path).slice(0, -1).join('/') : profile.parentPathOf(i.path, lowerPaths);
    if (folder === null || folder === '') return undefined;
    const parent = folderPage.get(folderKey(folder));
    return parent === i ? undefined : parent;
  };
  const depthMemo = new Map<string, number>();
  const depthOf = (i: ImportItem): number => {
    const known = depthMemo.get(i.id);
    if (known !== undefined) return known;
    depthMemo.set(i.id, 0); // a cycle (not possible from paths) reads as a root
    const parent = parentOf(i);
    const depth = parent === undefined ? 0 : depthOf(parent) + 1;
    depthMemo.set(i.id, depth);
    return depth;
  };

  // Decision 167: a database's row page that only repeats its row (its title, then `Column: value` lines of the table's columns, and no page under it) is no page of its own: it is
  // skipped `database_row`, and a link to it opens the database's page. That is read from the archive, the same whenever it is asked, so a page written before the row is dealt
  // with links to the right page; and it holds only while the database's page is, or is still to be, written: a database that failed shows no table, so its rows are kept as pages.
  const hasChildren = new Set<string>();
  for (const i of pageItems) { const p = parentOf(i); if (p !== undefined) hasChildren.add(p.id); }
  const databaseOf = (i: ImportItem): ImportItem | undefined => {
    if (i.kind !== 'page' || isContainer(i) || hasChildren.has(i.id)) return undefined;
    const parent = parentOf(i);
    return parent?.kind === 'database_csv' ? parent : undefined;
  };
  const repeatsRow = new Map<string, boolean>();
  for (const i of all) if (i.status === 'skipped' && i.message === 'database_row') repeatsRow.set(i.id, true);
  const rowIsBare = async (i: ImportItem, text?: string): Promise<boolean> => {
    const db = databaseOf(i);
    if (db === undefined || !tableShown(db)) return false;
    let known = repeatsRow.get(i.id);
    if (known === undefined) {
      const source = text ?? (await rowText(i.path));
      const names = (await tableOf(db))?.columns;
      known = source !== undefined && names !== undefined && onlyRepeatsRow(source.normalize('NFC'), names);
      repeatsRow.set(i.id, known);
    }
    return known;
  };
  const hasDatabases = pageItems.some((i) => i.kind === 'database_csv');

  // The import's budget of remote images: the copies made so far are kept in the counts, so a resumed run goes on from them (the time starts again with each run).
  const budget = deps.remote === undefined ? undefined : { ...createRemoteBudget({ remote: deps.remote.config }), taken: record.counts.remote ?? 0 };
  const queue = pageItems.filter((i) => i.status === 'pending').sort((a, b) => depthOf(a) - depthOf(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Warnings live on the item rows (written with the page or the settle), so the count is worked out from them like the others and survives a resumed or an overlapping run.
  const warned = new Map(all.map((i) => [i.id, i.warnings]));
  // The bytes of copies the written pages hold (on their rows, so a resumed run counts them), and the ones this run has made for pages not yet written.
  let copiedBytes = all.reduce((sum, i) => sum + i.attachmentBytes, 0);
  const counts = (): ImportCounts => {
    let pagesDone = 0, attachments = 0, skipped = 0, failed = 0;
    for (const i of all) {
      const s = status.get(i.id);
      if (s === 'ok' && (i.kind === 'page' || i.kind === 'database_csv')) pagesDone++;
      else if (s === 'ok' && i.kind === 'attachment') attachments++;
      else if (s === 'skipped') skipped++;
      else if (s === 'failed') failed++;
    }
    let warnings = 0;
    for (const n of warned.values()) warnings += n;
    return { pagesTotal: pageItems.length, pagesDone, attachments, skipped, failed, warnings, ...(budget === undefined ? {} : { remote: budget.taken }) };
  };
  /** The status another run gave an item this one lost the race for, read back (a written page keeps its ids, a settled one has none). */
  const adopt = async (item: ImportItem): Promise<void> => {
    const now = await repo.getItem(tenantId, importId, item.id);
    if (now === undefined) return;
    status.set(item.id, now.status);
    warned.set(item.id, now.warnings);
    itemById.set(item.id, now);
    const at = pageItems.findIndex((p) => p.id === item.id);
    if (at !== -1) pageItems[at] = now;
  };
  /** True when this run settled the item; false when another run had (it is read back, and this run's own warnings are not counted for an outcome it did not commit). */
  const settle = async (item: ImportItem, s: 'skipped' | 'failed', message: string, sizes: { markdownBytes?: number; stateBytes?: number; warnings?: number; remoteImageFailures?: Readonly<Record<string, number>> } = {}): Promise<boolean> => {
    if (await repo.settle(tenantId, importId, item.id, { status: s, message, ...sizes })) { status.set(item.id, s); warned.set(item.id, sizes.warnings ?? 0); return true; }
    await adopt(item);
    return false;
  };
  /** The page a child goes under: its folder's page if that was written, else the nearest ancestor that was. */
  const parentPageId = (item: ImportItem): string | null => {
    for (let p = parentOf(item); p !== undefined; p = parentOf(p)) if (status.get(p.id) === 'ok') return itemById.get(p.id)?.pageId ?? p.pageId;
    return null;
  };

  /** `wrote`: the page was written by this run, or by another run that won the race (its attachments are the same objects: deterministic ids). */
  type Step = { readonly stop?: PassTwoStop | 'busy'; readonly bytes: number; readonly wrote?: 'here' | 'other' };
  /** Files judged unfit for any page that uses them (a property of the file), decided once. */
  const rejected = new Map<string, Rejection>();
  const processInner = async (item: ImportItem, staged: Map<string, StagedFile>, copied: Map<string, StagedFile>): Promise<Step> => {
    const takenBefore = budget?.taken ?? 0;
    let original: Buffer | undefined;
    let markdown = '';
    let titleSource = '';
    let name = '';
    /** What this page held that was converted, dropped or kept (the construct report): counted while the text is handled, and kept only for a page that is written. */
    const constructs: Partial<Record<ConstructKind, number>> = {};
    const noted = (kind: ConstructKind): void => { constructs[kind] = (constructs[kind] ?? 0) + 1; };
    if (isContainer(item)) {
      name = segmentsOf(item.path).at(-1) ?? item.path;
    } else {
      const entry = entryByPath.get(item.path);
      if (entry === undefined) { await settle(item, 'failed', 'missing_entry'); return { bytes: 0 }; }
      const database = item.kind === 'database_csv';
      // A table has at least half the bytes of its CSV (a quoted `""` is the one character it stands for; any other byte of a CSV is a byte of the table, or more), so a CSV over four
      // times the cap makes no table under it: it is refused before it is read as a table, and kept as it is, streamed (decision 168). An entry that lies about its size, or expands
      // too far, is not kept: its reason is the item's, as for any entry.
      if (database && entry.size > 4 * tableCap) {
        try {
          await deps.files.put(importFailedKey(tenantId, importId, item.id), await deps.reader.openEntry(entry, deps.limits), { size: entry.size, contentType: 'text/csv' });
        } catch (e) {
          if (!(e instanceof EntryAbort)) throw e;
          await settle(item, 'failed', e.reason === 'entry_too_large' ? 'table_too_large' : e.reason);
          return { bytes: 0 };
        }
        await settle(item, 'failed', 'table_too_large');
        return { bytes: 0 };
      }
      // A database's CSV is read whole (its rows decide the table); a page's Markdown up to the seed cap.
      const read = await readEntry(deps.reader, deps.limits, entry, database ? 4 * tableCap : deps.limits.seedMaxMarkdownBytes);
      if (read.kind === 'too_large') { await settle(item, database ? 'failed' : 'skipped', database ? 'table_too_large' : 'too_large', { markdownBytes: entry.size }); return { bytes: 0 }; }
      if (read.kind === 'failed') { await settle(item, 'failed', read.reason); return { bytes: 0 }; }
      original = read.bytes;
      if (database) {
        const table = databaseTable(read.bytes, profile, tableCap);
        if (!table.ok) {
          // Decision 168: the CSV is kept, as a failed page's Markdown is, for the person to download from the report.
          await deps.files.put(importFailedKey(tenantId, importId, item.id), read.bytes, { size: read.bytes.length, contentType: 'text/csv' });
          await settle(item, 'failed', table.reason);
          return { bytes: read.bytes.length };
        }
        markdown = table.markdown;
      } else {
        try { titleSource = decoder.decode(read.bytes); } catch { await settle(item, 'failed', 'invalid_encoding', { markdownBytes: read.bytes.length }); return { bytes: read.bytes.length }; }
        if (await rowIsBare(item, titleSource)) { await settle(item, 'skipped', 'database_row'); return { bytes: read.bytes.length }; }
        markdown = profile.preprocess(titleSource, { path: item.path, onConstruct: noted });
      }
      name = profile.titleOf(item.path, titleSource);
    }
    const { title, cut } = cutTitle(name);
    let own = cut ? 1 : 0;
    const failures: Record<string, number> = {};
    // The files this page uses (stage 4d), found first and stored before the page is written; the rewrite then points each link at its attachment.
    if (deps.attachments !== undefined) {
      const wanted: ImportItem[] = [];
      const seen = rewriteMarkdown(markdown, (target) => {
        const found = profile.resolveLink(target, item.path, index);
        const file = found?.kind === 'attachment' ? itemById.get(found.itemId) : undefined;
        if (file !== undefined && !wanted.includes(file)) wanted.push(file);
        return undefined;
      });
      const stage: StageContext = { files: deps.files, reader: deps.reader, limits: deps.limits, settings: deps.attachments, tenantId, importId, uploaderId: importer, now: deps.now };
      for (const file of wanted) {
        if (rejected.has(file.id)) continue;
        const entry = entryByPath.get(file.path);
        // A copy that would take the copies of the import past its budget is not made: the import stops, and ends failed (the pages before it are trashed with it, as for any failed import).
        // Only a file that would be copied is charged: one that is refused for its type, its size or its emptiness costs nothing (`stageAttachment` skips it without a copy).
        if (entry !== undefined && deps.limits.maxCopiedBytes !== undefined && !('status' in judgeFile(stage, entry)) && copiedBytes + entry.size > deps.limits.maxCopiedBytes) return { stop: 'attachment_budget', bytes: 0 };
        const result: Staged = entry === undefined ? { kind: 'rejected', status: 'failed', reason: 'missing_entry' } : await stageAttachment(stage, entry, item.path);
        if (result.kind === 'ok') { staged.set(file.id, result); copiedBytes += result.row.size; continue; }
        if (result.scope === 'page') continue; // this page's object, not the file: this page keeps its link, other pages may still use the file
        rejected.set(file.id, result);
        if (status.get(file.id) === 'pending') await settle(file, result.status, result.reason);
      }
      // Remote images (contracts section 5), each distinct address once: an https one is copied into the tool, an http one or one with no fetcher stays a link and is a warning.
      if (deps.remote !== undefined && budget !== undefined) {
        for (const url of new Set(seen.remoteImages)) {
          // A reason code, never the address: what the report may show of a failed copy.
          const why = (reason: string): void => { own++; failures[reason] = (failures[reason] ?? 0) + 1; };
          if (!/^https:/i.test(url)) { why('scheme'); continue; }
          if (deps.remote.fetcher === undefined) { why('not_fetched'); continue; }
          const got = await stageRemoteImage(stage, deps.remote.fetcher, budget, url, item.path);
          if (got.kind === 'ok') { copied.set(url, got); copiedBytes += got.row.size; } else why(got.reason);
        }
      }
    }
    // The rows this page links to are known before the rewrite, which cannot wait: a link to a row that only repeats its row opens its database's page (decision 167).
    if (hasDatabases) {
      const rows: ImportItem[] = [];
      rewriteMarkdown(markdown, (target) => {
        const found = profile.resolveLink(target, item.path, index);
        const linked = found?.kind === 'page' ? itemById.get(found.itemId) : undefined;
        if (linked !== undefined && databaseOf(linked) !== undefined) rows.push(linked);
        return undefined;
      });
      for (const row of rows) await rowIsBare(row);
    }
    // Targets the archive holds but that were not turned into a link (a file that was refused, a page that is not written): left as written, and not "unresolved" for the report.
    let heldButKept = 0;
    const rewritten = rewriteMarkdown(markdown, (target, kind): Resolved | undefined => {
      const found = profile.resolveLink(target, item.path, index);
      if (found === undefined) return undefined;
      const resolved = ((): Resolved | undefined => {
        if (found.kind === 'attachment') { const file = staged.get(found.itemId); return file === undefined ? undefined : { kind: 'file', url: file.url }; }
        if (kind === 'image') return undefined; // an image that is a page is nothing to point at
        const linked = itemById.get(found.itemId);
        // A link to a row that only repeats its row opens its database's page, while that page is, or is still to be, written (decision 167).
        const db = linked === undefined || repeatsRow.get(linked.id) !== true ? undefined : databaseOf(linked);
        const targetItem = db !== undefined && tableShown(db) ? db : linked;
        return targetItem?.urlId == null || (status.get(targetItem.id) !== 'ok' && status.get(targetItem.id) !== 'pending') ? undefined : { kind: 'page', url: `/p/${targetItem.urlId}` };
      })();
      if (resolved === undefined) heldButKept += 1;
      return resolved;
    }, (url) => copied.get(url)?.url);
    own += rewritten.unresolved.length;
    for (const [kind, n] of [['page_mention', rewritten.pageLinks], ['unresolved_link', rewritten.unresolved.length - heldButKept], ['raw_html', rewritten.htmlFragments]] as const) if (n > 0) constructs[kind] = n;

    const bytes = original?.length ?? 0;
    const outcome = await normalizePage(deps.converter, record.createdBy ?? importId, title, rewritten.markdown, deps.limits.maxStateBytes);
    // The copies made for this page are removed and the page is tried again later: they are not charged to the import's budget.
    if (outcome.kind === 'retry') { if (budget !== undefined) budget.taken = takenBefore; return { stop: 'busy', bytes }; }
    if (outcome.kind === 'skipped') { await settle(item, 'skipped', outcome.reason, { markdownBytes: outcome.markdownBytes, warnings: own, remoteImageFailures: failures }); return { bytes }; }
    if (outcome.kind === 'failed') {
      // The original, not the rewritten text: what the person wrote, to take elsewhere.
      if (original !== undefined) await deps.files.put(importFailedKey(tenantId, importId, item.id), original, { size: original.length, contentType: 'text/markdown' });
      await settle(item, 'failed', outcome.reason, { markdownBytes: outcome.markdownBytes, warnings: own, remoteImageFailures: failures, ...(outcome.stateBytes === undefined ? {} : { stateBytes: outcome.stateBytes }) });
      return { bytes };
    }
    const written: WriteImportedPageResult = await repo.writePage(tenantId, importId, {
      itemId: item.id, collectionId: record.targetCollectionId, parentId: parentPageId(item), position: (before, after) => deps.ordering.between(before, after), title, createdBy: importer,
      content: { state: outcome.state, markdown: outcome.markdown, text: outcome.text, hash: outcome.hash }, markdownBytes: outcome.markdownBytes, stateBytes: outcome.stateBytes, warnings: own, constructs, remoteImageFailures: failures, attachments: [...staged.values(), ...copied.values()].map((f) => f.row), attachmentItemIds: [...staged.keys()],
    }, deps.pageLimits, deps.now());
    switch (written.kind) {
      case 'ok': status.set(item.id, 'ok'); warned.set(item.id, own); for (const id of staged.keys()) if (status.get(id) === 'pending') status.set(id, 'ok'); return { bytes, wrote: 'here' };
      case 'not-pending': await adopt(item); for (const id of staged.keys()) await adopt(itemById.get(id) as ImportItem); return { bytes, wrote: 'other' };
      case 'not-running': return { stop: 'not_running', bytes };
      case 'collection-deleted': return { stop: 'collection_deleted', bytes };
      case 'collection-full': await settle(item, 'failed', 'collection_full', { markdownBytes: outcome.markdownBytes, stateBytes: outcome.stateBytes, warnings: own, remoteImageFailures: failures }); return { bytes };
      case 'tenant-pages-full': await settle(item, 'failed', 'tenant_pages_full', { markdownBytes: outcome.markdownBytes, stateBytes: outcome.stateBytes, warnings: own, remoteImageFailures: failures }); return { bytes };
      case 'too-deep': await settle(item, 'failed', 'too_deep', { markdownBytes: outcome.markdownBytes, stateBytes: outcome.stateBytes, warnings: own, remoteImageFailures: failures }); return { bytes };
      case 'no-parent': await settle(item, 'failed', 'internal', { markdownBytes: outcome.markdownBytes, stateBytes: outcome.stateBytes, warnings: own, remoteImageFailures: failures }); return { bytes };
    }
  };

  /** Stores the files a page uses, writes the page, and then either settles the files it used as ok or removes the objects it stored for a page that was not written. */
  const processItem = async (item: ImportItem): Promise<Step> => {
    const staged = new Map<string, StagedFile>();
    const copied = new Map<string, StagedFile>();
    const step = await processInner(item, staged, copied);
    // Objects are removed only for a page that is known not to be written: keys are deterministic, so another run that wrote the page has rows that point at them.
    if (step.wrote !== 'here' && staged.size + copied.size > 0 && (await repo.getItem(tenantId, importId, item.id))?.status !== 'ok') {
      for (const f of [...staged.values(), ...copied.values()]) await deps.files.delete(f.row.key);
      // The copies are gone: their bytes are given back to the budget, which counts the copies that are kept.
      copiedBytes -= [...staged.values(), ...copied.values()].reduce((sum, f) => sum + f.row.size, 0);
    }
    return step;
  };

  const finish = async (result: (c: ImportCounts) => PassTwoResult): Promise<PassTwoResult> => {
    const c = counts();
    await repo.setCounts(tenantId, importId, c);
    return result(c);
  };

  for (let at = 0; at < queue.length; ) {
    // A run does at least one batch before it looks at the signal, so a chunk whose time is already up still moves the import on (a continuation that never progressed would never end).
    if (at > 0 && options.signal?.aborted === true) return finish((c) => ({ kind: 'stopped', reason: 'aborted', counts: c }));
    // Before each batch the import is read again: a cancel (or a failure) stops the run here.
    if ((await repo.get(tenantId, importId))?.status !== 'running') return finish((c) => ({ kind: 'stopped', reason: 'not_running', counts: c }));
    let pages = 0;
    let bytes = 0;
    let persistedTaken = budget?.taken ?? 0;
    while (at < queue.length && pages < batchPages && bytes < batchBytes) {
      const step = await processItem(queue[at] as ImportItem);
      at++;
      pages++;
      bytes += step.bytes;
      // The copies of this page are counted before the next page starts, so a run that dies mid-batch resumes from them, not from the count of the last batch.
      if (budget !== undefined && budget.taken !== persistedTaken && step.stop === undefined) { await repo.setCounts(tenantId, importId, counts()); persistedTaken = budget.taken; }
      if (step.stop === 'busy') return finish((c) => ({ kind: 'busy', counts: c }));
      if (step.stop !== undefined) return finish((c) => ({ kind: 'stopped', reason: step.stop as PassTwoStop, counts: c }));
    }
    await repo.setCounts(tenantId, importId, counts());
  }
  // Every page is dealt with: a file that no page used is skipped (a file used by a page that failed is one too: nothing was stored for it).
  for (const i of all) if (i.kind === 'attachment' && status.get(i.id) === 'pending') await settle(i, 'skipped', 'unreferenced');
  return finish((c) => ({ kind: 'done', counts: c }));
}
