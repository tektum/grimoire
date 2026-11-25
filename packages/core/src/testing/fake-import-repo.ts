import { cleanItemText as clean, NO_IMPORT_COUNTS } from '../ports/import-repo.js';
import type { ImportCounts, ImportItem, ImportItemKind, ImportRecord, ImportRepo, ItemOutcome, NewImportItem } from '../ports/import-repo.js';

const depth = (path: string): number => path.split('/').length;

interface Stored { tenantId: string; importId: string; item: ImportItem }

/** In-memory imports for tests. */
export class FakeImportRepo implements ImportRepo {
  private readonly rows: ImportRecord[] = [];
  private readonly stored: Stored[] = [];
  private next = 1;

  seed(row: Omit<ImportRecord, 'counts' | 'error' | 'startedAt' | 'finishedAt' | 'source' | 'targetCollectionId' | 'createdBy'> & Partial<ImportRecord>): ImportRecord {
    const full: ImportRecord = { source: 'markdown_zip', targetCollectionId: 'c', createdBy: null, counts: NO_IMPORT_COUNTS, error: null, startedAt: null, finishedAt: null, ...row };
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

  start(tenantId: string, id: string, now: number): Promise<ImportRecord | undefined> {
    const at = this.find(tenantId, id);
    const row = this.rows[at];
    if (row === undefined || (row.status !== 'uploaded' && row.status !== 'running')) return Promise.resolve(undefined);
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
}
