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
}

export interface NewImportItem {
  readonly path: string;
  readonly kind: ImportItemKind;
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
}

/** How an item ends without a page: left out on purpose (`skipped`) or not readable (`failed`), with the reason as its message. */
export interface ItemOutcome {
  readonly status: 'skipped' | 'failed';
  readonly message: string;
  readonly markdownBytes?: number;
  readonly stateBytes?: number;
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
  /** Adds items to an import; a path already there is left as it is (resuming never duplicates). Resolves with the number added. */
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
  /** `uploaded` or `running` becomes `running` (and `startedAt` is set once); any other status is left as it is and nothing is returned. */
  start(tenantId: string, id: string, now: number): Promise<ImportRecord | undefined>;
  /** Writes the counts of a running import; `false` when it is not running (a cancelled import keeps the counts it had). */
  setCounts(tenantId: string, id: string, counts: ImportCounts): Promise<boolean>;
  /** A running import ends as `done` or `failed` (`error` is a code); `false` when it is not running (a cancelled one stays cancelled). */
  finish(tenantId: string, id: string, status: 'done' | 'failed', error: string | null, now: number): Promise<boolean>;
}
