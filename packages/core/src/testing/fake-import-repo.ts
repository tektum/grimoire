import { cleanItemText as clean, ImportBusyError, NO_IMPORT_COUNTS } from '../ports/import-repo.js';
import type { ImportCounts, ImportItem, ImportItemKind, ImportRecord, ImportRepo, ItemOutcome, NewImport, NewImportedPage, NewImportItem, WriteImportedPageResult } from '../ports/import-repo.js';

const depth = (path: string): number => path.split('/').length;

interface Stored { tenantId: string; importId: string; item: ImportItem }

/** In-memory imports for tests. */
export class FakeImportRepo implements ImportRepo {
  private readonly rows: ImportRecord[] = [];
  private readonly stored: Stored[] = [];
  private next = 1;

  seed(row: Omit<ImportRecord, 'counts' | 'error' | 'startedAt' | 'finishedAt' | 'source' | 'targetCollectionId' | 'createdBy' | 'bytes' | 's3Key'> & Partial<ImportRecord>): ImportRecord {
    const full: ImportRecord = { bytes: null, s3Key: null, source: 'markdown_zip', targetCollectionId: 'c', createdBy: null, counts: NO_IMPORT_COUNTS, error: null, startedAt: null, finishedAt: null, ...row };
    this.rows.push(full);
    return full;
  }

  private find(tenantId: string, id: string): number {
    return this.rows.findIndex((r) => r.tenantId === tenantId && r.id === id);
  }

  private replace(index: number, patch: Partial<ImportRecord>): ImportRecord {
    const row = { ...(this.rows[index] as ImportRecord), ...patch };
    this.rows[index] = row;
    return row;
  }

  /** Moves a seeded import to a status (what a cancel does). */
  setStatus(id: string, status: ImportRecord['status']): void {
    const at = this.rows.findIndex((r) => r.id === id);
    if (at !== -1) this.replace(at, { status });
  }

  get(tenantId: string, id: string): Promise<ImportRecord | undefined> {
    return Promise.resolve(this.rows[this.find(tenantId, id)]);
  }

  addItems(tenantId: string, importId: string, items: readonly NewImportItem[]): Promise<number> {
    if (this.find(tenantId, importId) === -1) return Promise.resolve(0);
    let added = 0;
    for (const item of items) {
      const path = item.path;
      if (this.stored.some((s) => s.importId === importId && s.item.path === path)) continue;
      this.stored.push({ tenantId, importId, item: { id: String(this.next++), path, kind: item.kind, status: 'pending', pageId: null, urlId: null, message: null, markdownBytes: null, stateBytes: null, attempts: 0 } });
      added += 1;
    }
    return Promise.resolve(added);
  }

  pending(tenantId: string, importId: string, kind: ImportItemKind, limit: number): Promise<readonly ImportItem[]> {
    const items = this.stored.filter((s) => s.tenantId === tenantId && s.importId === importId && s.item.kind === kind && s.item.status === 'pending').map((s) => s.item);
    return Promise.resolve(items.sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, limit));
  }

  getItem(tenantId: string, importId: string, itemId: string): Promise<ImportItem | undefined> {
    return Promise.resolve(this.stored.find((s) => s.tenantId === tenantId && s.importId === importId && s.item.id === itemId)?.item);
  }

  settle(tenantId: string, importId: string, itemId: string, outcome: ItemOutcome): Promise<boolean> {
    const at = this.stored.findIndex((s) => s.tenantId === tenantId && s.importId === importId && s.item.id === itemId && s.item.status === 'pending');
    const found = this.stored[at];
    if (found === undefined) return Promise.resolve(false);
    this.stored[at] = { ...found, item: { ...found.item, status: outcome.status, message: clean(outcome.message), markdownBytes: outcome.markdownBytes ?? null, stateBytes: outcome.stateBytes ?? null } };
    return Promise.resolve(true);
  }

  /** The pages written, in order. */
  readonly written: { tenantId: string; importId: string; page: NewImportedPage; position: string }[] = [];

  /** Settles the item as `ok` and records the page; the limits and the tree are not modelled (the PostgreSQL repo checks them). */
  writePage(tenantId: string, importId: string, page: NewImportedPage): Promise<WriteImportedPageResult> {
    const owner = this.find(tenantId, importId);
    if (owner === -1) return Promise.resolve({ kind: 'collection-deleted' });
    if (this.rows[owner]?.status !== 'running') return Promise.resolve({ kind: 'not-running' });
    const at = this.stored.findIndex((s) => s.tenantId === tenantId && s.importId === importId && s.item.id === page.itemId && s.item.status === 'pending');
    const found = this.stored[at];
    if (found === undefined) return Promise.resolve({ kind: 'not-pending' });
    const lastOfParent = this.written.filter((w) => w.importId === importId && w.page.collectionId === page.collectionId && w.page.parentId === page.parentId).map((w) => w.position).sort().at(-1) ?? null;
    const position = page.position(lastOfParent, null);
    const pageId = `page-${String(this.next++)}`;
    const urlId = `u${pageId}`;
    this.stored[at] = { ...found, item: { ...found.item, status: 'ok', pageId, urlId, message: null, markdownBytes: page.markdownBytes, stateBytes: page.stateBytes } };
    this.written.push({ tenantId, importId, page, position });
    return Promise.resolve({ kind: 'ok', pageId, urlId });
  }

  start(tenantId: string, id: string, now: number): Promise<ImportRecord | undefined> {
    const at = this.find(tenantId, id);
    const row = this.rows[at];
    if (row === undefined || (row.status !== 'uploaded' && row.status !== 'running')) return Promise.resolve(undefined);
    if (row.status === 'uploaded' && this.rows.some((r) => r.tenantId === tenantId && r.status === 'running')) return Promise.reject(new ImportBusyError());
    return Promise.resolve(this.replace(at, { status: 'running', startedAt: row.startedAt ?? now }));
  }

  setCounts(tenantId: string, id: string, counts: ImportCounts): Promise<boolean> {
    const at = this.find(tenantId, id);
    if (this.rows[at]?.status !== 'running') return Promise.resolve(false);
    this.replace(at, { counts });
    return Promise.resolve(true);
  }

  finish(tenantId: string, id: string, status: 'done' | 'failed', error: string | null, now: number): Promise<boolean> {
    const at = this.find(tenantId, id);
    if (this.rows[at]?.status !== 'running') return Promise.resolve(false);
    this.replace(at, { status, error, finishedAt: now });
    return Promise.resolve(true);
  }

  // What the routes use.
  create(tenantId: string, row: NewImport): Promise<ImportRecord> {
    const made: ImportRecord = { id: row.id, tenantId, status: 'created', source: row.source, targetCollectionId: row.targetCollectionId, createdBy: row.createdBy, counts: NO_IMPORT_COUNTS, error: null, startedAt: null, finishedAt: null, bytes: row.bytes, s3Key: row.s3Key };
    this.rows.push(made);
    return Promise.resolve(made);
  }

  markUploaded(tenantId: string, id: string): Promise<boolean> {
    const at = this.find(tenantId, id);
    const row = this.rows[at];
    if (row === undefined || (row.status !== 'created' && row.status !== 'uploaded')) return Promise.resolve(false);
    this.replace(at, { status: 'uploaded' });
    return Promise.resolve(true);
  }

  listItems(tenantId: string, importId: string, options: { readonly afterId?: string; readonly limit: number }): Promise<readonly ImportItem[]> {
    const after = options.afterId === undefined ? -1n : BigInt(options.afterId);
    const items = this.stored.filter((s) => s.tenantId === tenantId && s.importId === importId && s.item.status !== 'pending' && BigInt(s.item.id) > after).map((s) => s.item);
    return Promise.resolve(items.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).slice(0, options.limit));
  }

  cancel(tenantId: string, id: string, now: number): Promise<ImportRecord | undefined> {
    const at = this.find(tenantId, id);
    const status = this.rows[at]?.status;
    if (status !== 'running' && status !== 'uploaded') return Promise.resolve(undefined);
    return Promise.resolve(this.replace(at, { status: 'cancelled', finishedAt: now }));
  }
}
