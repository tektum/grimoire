import type { NewReady } from './attachment-repo.js';
import type { TenantPageLimits } from './page-repo.js';

/** `imports.status` (M7 contracts section 4): `created` then `uploaded` then `running`, which ends as `done`, `failed` or `cancelled`. */
export type ImportStatus = 'created' | 'uploaded' | 'running' | 'done' | 'failed' | 'cancelled';
export type ImportSource = 'notion_md_csv' | 'markdown_zip';
export type ImportItemKind = 'page' | 'attachment' | 'database_csv' | 'other';
export type ImportItemStatus = 'pending' | 'ok' | 'skipped' | 'failed';

export interface ImportCounts {
  readonly pagesTotal: number;
  readonly pagesDone: number;
  readonly attachments: number;
  readonly skipped: number;
  readonly failed: number;
  readonly warnings: number;
}

export const NO_IMPORT_COUNTS: ImportCounts = { pagesTotal: 0, pagesDone: 0, attachments: 0, skipped: 0, failed: 0, warnings: 0 };

export interface ImportRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly status: ImportStatus;
  readonly source: ImportSource;
  readonly targetCollectionId: string;
  readonly createdBy: string | null;
  readonly counts: ImportCounts;
  readonly error: string | null;
  /** Milliseconds since the epoch; null until the import starts (and finishes). */
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** The size the person declared for the zip, and where the zip is kept (`tenants/<tenant>/imports/<id>/source.zip`); null on a row that has neither. */
  readonly bytes: number | null;
  readonly s3Key: string | null;
}

/** What `create` needs: the import starts as `created`. */
export interface NewImport {
  readonly id: string;
  readonly targetCollectionId: string;
  readonly createdBy: string;
  readonly source: ImportSource;
  readonly bytes: number;
  readonly s3Key: string;
}

/** Thrown by `start` when another import of the tenant is running (decision 6: a workspace has one running import at a time). The import stays `uploaded` and its job is tried again later. */
export class ImportBusyError extends Error {
  constructor() {
    super('another import of the tenant is running');
    this.name = 'ImportBusyError';
  }
}

export interface NewImportItem {
  readonly path: string;
  readonly kind: ImportItemKind;
  /** Added already ended: `skipped` (left out on purpose, such as an ignored entry) or `failed` (such as a bad name), with the reason as its message. Absent: `pending`. */
  readonly status?: 'skipped' | 'failed';
  readonly message?: string;
}

export interface ImportItem {
  readonly id: string;
  readonly path: string;
  readonly kind: ImportItemKind;
  readonly status: ImportItemStatus;
  readonly pageId: string | null;
  readonly urlId: string | null;
  readonly message: string | null;
  readonly markdownBytes: number | null;
  readonly stateBytes: number | null;
  readonly attempts: number;
  /** Warnings this item raised (a cut title, a link that matched nothing), kept on the row so the import's count is worked out from the rows and survives a resumed or overlapping run. */
  readonly warnings: number;
}

/** How an item ends without a page: left out on purpose (`skipped`) or not readable (`failed`), with the reason as its message. */
export interface ItemOutcome {
  /** `ok` is for a file used by a page (an attachment item); a page item becomes `ok` only through `writePage`, and a settle of it as `ok` is refused. */
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly message: string;
  readonly markdownBytes?: number;
  readonly stateBytes?: number;
  readonly warnings?: number;
}

/** The longest message an item row keeps (archive-controlled text, contracts section 4, step 8). */
export const MAX_ITEM_TEXT = 300;

/** A message as an item row keeps it: control characters removed, at most `MAX_ITEM_TEXT` characters. */
export const cleanItemText = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_ITEM_TEXT);

/** What a page of an import is written with. The attachments are those the page uses (their `pageId` is the new page's, set by the repo). */
export interface NewImportedPage {
  /** The `pending` page item this page settles. */
  readonly itemId: string;
  readonly collectionId: string;
  readonly parentId: string | null;
  /** The fractional position among the siblings, computed inside the locked transaction from the last live sibling under the parent (`before`) and `null` (`after`), so a page made by someone else in the meantime cannot collide with it. */
  readonly position: (before: string | null, after: string | null) => string;
  readonly title: string;
  /** The importer: `created_by`, `last_edited_by` and the author of the `import` revision. */
  readonly createdBy: string;
  /** What `normalizePage` made: the seeded state with the canonical Markdown, its text and hash (R10.13, R7.13: never Markdown without state). */
  readonly content: { readonly state: Uint8Array; readonly markdown: string; readonly text: string; readonly hash: Buffer };
  readonly markdownBytes: number;
  readonly stateBytes: number;
  readonly warnings?: number;
  readonly attachments: readonly Omit<NewReady, 'pageId'>[];
}

/** `not-running`: the import was cancelled, failed or finished, so nothing is written (a late page would escape the trash batch of a cancelled or failed import). `not-pending`: the item was settled already (a resumed run, a duplicate), so nothing is written. The rest are the refusals of a page create. */
export type WriteImportedPageResult =
  | { readonly kind: 'ok'; readonly pageId: string; readonly urlId: string }
  | { readonly kind: 'not-running' | 'not-pending' | 'collection-deleted' | 'no-parent' | 'too-deep' | 'collection-full' | 'tenant-pages-full' };

/**
 * The imports of a workspace (M7 contracts section 4). Every call names the tenant: another tenant's import is not found (`undefined`, `false`, `0` or no rows, never an error).
 * A message is stored at most `MAX_ITEM_TEXT` characters long and without control characters. A path is the key of an entry in the archive (links resolve to it, a resumed run
 * finds its items by it), so it is stored exactly as given and never cut or cleaned: it is cut for display where it is shown (the report routes), not here.
 */
export interface ImportRepo {
  get(tenantId: string, id: string): Promise<ImportRecord | undefined>;
  /**
   * Adds items to an import; a path already there is left as it is (resuming never duplicates). Resolves with the number added. A `pending` page item is given its page id and URL id here,
   * so a link to a page that is written later can point at it (the page is written under them, see `writePage`); no other item has either.
   */
  addItems(tenantId: string, importId: string, items: readonly NewImportItem[]): Promise<number>;
  /** The `pending` items of a kind, parents before children (fewer path segments first, then by path), at most `limit`. */
  pending(tenantId: string, importId: string, kind: ImportItemKind, limit: number): Promise<readonly ImportItem[]>;
  getItem(tenantId: string, importId: string, itemId: string): Promise<ImportItem | undefined>;
  /** Ends a `pending` item as `skipped` or `failed`; `false` when it was not pending. */
  settle(tenantId: string, importId: string, itemId: string, outcome: ItemOutcome): Promise<boolean>;
  /**
   * One page of the import in ONE transaction (contract stage 4e): the collection row is locked, the import must still be `running` (its row is locked in share mode, so a cancel or a finish waits for the write and a write after one finds the status changed), the item must still be `pending` (a resumed run never writes a page twice), the
   * parent must be live in the collection, the depth, the collection's page count and the tenant's cap are checked, then the page (with its state), the `import` revision, the
   * attachment rows and the item as `ok` are written together: a failure anywhere leaves no page, no revision, no attachment row, and the item pending.
   */
  writePage(tenantId: string, importId: string, page: NewImportedPage, limits: TenantPageLimits, now: number): Promise<WriteImportedPageResult>;
  /**
   * `uploaded` or `running` becomes `running` (and `startedAt` is set once); any other status is left as it is and nothing is returned. A tenant has one running import at a time: the database
   * holds it, and when another import of the tenant is running this rejects with `ImportBusyError` and leaves the import `uploaded`, for the job to try again later.
   */
  start(tenantId: string, id: string, now: number): Promise<ImportRecord | undefined>;
  /** Writes the counts of a running import; `false` when it is not running (a cancelled import keeps the counts it had). */
  setCounts(tenantId: string, id: string, counts: ImportCounts): Promise<boolean>;
  /** A running import ends as `done` or `failed` (`error` is a code); `false` when it is not running (a cancelled one stays cancelled). */
  finish(tenantId: string, id: string, status: 'done' | 'failed', error: string | null, now: number): Promise<boolean>;

  // What the routes of M7-T05 use. Everything above is the engine's and stays as it is.
  /** Makes an import row, `created`, for the tenant. */
  create(tenantId: string, row: NewImport): Promise<ImportRecord>;
  /** `created` or `uploaded` becomes `uploaded`; `false` for any other status (and for another tenant's import). */
  markUploaded(tenantId: string, id: string): Promise<boolean>;
  /** The settled items (`ok`, `skipped` or `failed`: not the ones still `pending`), in ascending id, after `afterId` when given, at most `limit`. Ids compare as whole numbers. */
  /** Every item of the import in any status (`listItems` is for the report and leaves out the pending ones), by id: what the engine builds its link index from. Keyset on `afterId`. */
  scanItems(tenantId: string, importId: string, options: { readonly afterId?: string; readonly limit: number }): Promise<readonly ImportItem[]>;
  listItems(tenantId: string, importId: string, options: { readonly afterId?: string; readonly limit: number }): Promise<readonly ImportItem[]>;
  /** `running` or `uploaded` (accepted and waiting for its turn) becomes `cancelled` (`finishedAt` set) and the row is returned; any other status is left as it is and nothing is returned. */
  cancel(tenantId: string, id: string, now: number): Promise<ImportRecord | undefined>;
  // What the jobs of M7-T05 use. They walk the tenants one by one (the tenant list is the operator's), so every call here names its tenant like the rest.
  /** The ids of the tenant's imports in `running` (a tenant has at most one): the sweep asks the queue whether each still has a live job. */
  running(tenantId: string): Promise<readonly string[]>;
  /** The ids of the imports still `created` or `uploaded` that were created at or before `createdBefore` (milliseconds), oldest first, at most `limit`: uploads that were never finished. */
  stale(tenantId: string, createdBefore: number, limit: number): Promise<readonly string[]>;
  /** `created` or `uploaded` becomes `failed` with the error `abandoned` (`finishedAt` set); false, and nothing changed, for any other status, so it is safe to repeat. */
  abandon(tenantId: string, id: string, now: number): Promise<boolean>;
  /**
   * Moves the pages the import created to the trash, as deleting a page does: every live page of an `ok` page item, with its live descendants (a page a person added under an imported one goes with
   * it, so one restore brings them back together), each subtree in a batch of its own named by its root's id (as a page delete does: one restore checks what it must), deleted by the importer.
   * Pages already in the trash are left as they are, so a second call finds nothing (`pages: 0`, `batches: []`). `undefined` when the tenant has no such import. The status is not looked at: the job that calls it decides.
   */
  trashImported(tenantId: string, id: string): Promise<{ readonly batches: readonly string[]; readonly pages: number } | undefined>;
}
