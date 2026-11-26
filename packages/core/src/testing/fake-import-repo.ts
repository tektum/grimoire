import { cleanItemText as clean, CONSTRUCT_FATES, ImportBusyError, MAX_REPORT_PAGES, NO_IMPORT_COUNTS, StagingQuotaError } from '../ports/import-repo.js';
import type { ConstructKind, ConstructReport, ImportCounts, ImportItem, ImportItemKind, ImportPart, ImportRecord, ImportRepo, ItemOutcome, NewImport, NewImportedPage, NewImportItem, WriteImportedPageResult } from '../ports/import-repo.js';

const depth = (path: string): number => path.split('/').length;

interface Stored { tenantId: string; importId: string; item: ImportItem }

/** In-memory imports for tests. */
export class FakeImportRepo implements ImportRepo {
  private readonly rows: ImportRecord[] = [];
  private readonly stored: Stored[] = [];
  private next = 1;
  private readonly createdAt = new Map<string, number>();
  private readonly trashed = new Set<string>();
  private readonly partRows: { tenantId: string; importId: string; part: ImportPart }[] = [];

  seed(row: Omit<ImportRecord, 'counts' | 'error' | 'startedAt' | 'finishedAt' | 'source' | 'targetCollectionId' | 'createdBy' | 'bytes' | 's3Key'> & Partial<ImportRecord>, createdAt?: number): ImportRecord {
    const full: ImportRecord = { bytes: null, s3Key: null, source: 'markdown_zip', targetCollectionId: 'c', createdBy: null, counts: NO_IMPORT_COUNTS, error: null, startedAt: null, finishedAt: null, ...row };
    if (createdAt !== undefined) this.createdAt.set(full.id, createdAt);
    const at = this.find(full.tenantId, full.id);
    if (at === -1) this.rows.push(full);
    else this.rows[at] = full;
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

  /** Test setup: how many imports there are, of every tenant. */
  count(): number {
    return this.rows.length;
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
      const id = String(this.next++);
      const pending = item.status === undefined;
      // A page, and a database that becomes one, gets its ids as it is added.
      const ids = pending && (item.kind === 'page' || item.kind === 'database_csv') ? { pageId: `page-${id}`, urlId: `u-${id}` } : { pageId: null, urlId: null };
      this.stored.push({ tenantId, importId, item: { id, path, kind: item.kind, status: item.status ?? 'pending', ...ids, message: item.message === undefined ? null : clean(item.message), markdownBytes: null, stateBytes: null, attempts: 0, warnings: 0, attachmentBytes: 0, remoteImageFailures: {} } });
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
    if (found === undefined || (outcome.status === 'ok' && found.item.kind === 'page')) return Promise.resolve(false);
    this.stored[at] = { ...found, item: { ...found.item, status: outcome.status, pageId: null, urlId: null, warnings: outcome.warnings ?? 0, remoteImageFailures: outcome.remoteImageFailures ?? {}, message: outcome.status === 'ok' ? null : clean(outcome.message), markdownBytes: outcome.markdownBytes ?? null, stateBytes: outcome.stateBytes ?? null } };
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
    const pageId = found.item.pageId ?? `page-${String(this.next++)}`;
    const urlId = found.item.urlId ?? `u${pageId}`;
    this.stored[at] = { ...found, item: { ...found.item, status: 'ok', pageId, urlId, warnings: page.warnings ?? 0, attachmentBytes: page.attachments.reduce((sum, a) => sum + a.size, 0), remoteImageFailures: page.remoteImageFailures ?? {}, message: null, markdownBytes: page.markdownBytes, stateBytes: page.stateBytes } };
    for (const fileId of page.attachmentItemIds ?? []) {
      const f = this.stored.findIndex((x) => x.tenantId === tenantId && x.importId === importId && x.item.id === fileId && x.item.status === 'pending' && x.item.kind === 'attachment');
      const file = this.stored[f];
      if (file !== undefined) this.stored[f] = { ...file, item: { ...file.item, status: 'ok', message: null } };
    }
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
    const first = row.parts[0];
    if (first === undefined) return Promise.reject(new Error('an import has at least one zip'));
    const total = row.parts.reduce((sum, p) => sum + p.bytes, 0);
    const held = this.rows.filter((r) => r.tenantId === tenantId && (r.status === 'created' || r.status === 'uploaded' || r.status === 'running')).reduce((sum, r) => sum + (r.bytes ?? 0), 0);
    if (row.stagedQuotaBytes !== undefined && held + total > row.stagedQuotaBytes) return Promise.reject(new StagingQuotaError());
    const made: ImportRecord = { id: row.id, tenantId, status: 'created', source: row.source, targetCollectionId: row.targetCollectionId, createdBy: row.createdBy, counts: NO_IMPORT_COUNTS, error: null, startedAt: null, finishedAt: null, bytes: row.parts.reduce((sum, p) => sum + p.bytes, 0), s3Key: first.s3Key };
    this.rows.push(made);
    row.parts.forEach((part, ordinal) => this.partRows.push({ tenantId, importId: row.id, part: { ordinal, ...part } }));
    return Promise.resolve(made);
  }

  parts(tenantId: string, importId: string): Promise<readonly ImportPart[]> {
    return Promise.resolve(this.partRows.filter((p) => p.tenantId === tenantId && p.importId === importId).map((p) => p.part).sort((a, b) => a.ordinal - b.ordinal));
  }

  addPart(tenantId: string, importId: string, part: ImportPart): Promise<boolean> {
    const row = this.rows[this.find(tenantId, importId)];
    if (row?.status !== 'created') return Promise.resolve(false);
    if (this.partRows.some((p) => p.tenantId === tenantId && p.importId === importId && p.part.ordinal === part.ordinal)) return Promise.resolve(false);
    this.partRows.push({ tenantId, importId, part: { ...part } });
    return Promise.resolve(true);
  }

  closePart(tenantId: string, importId: string, ordinal: number): Promise<boolean> {
    const found = this.partRows.find((p) => p.tenantId === tenantId && p.importId === importId && p.part.ordinal === ordinal);
    if (found === undefined || found.part.uploadId === null) return Promise.resolve(false);
    found.part = { ...found.part, uploadId: null };
    return Promise.resolve(true);
  }

  constructReport(tenantId: string, importId: string): Promise<ConstructReport | undefined> {
    if (this.find(tenantId, importId) === -1) return Promise.resolve(undefined);
    const items = this.stored.filter((s) => s.tenantId === tenantId && s.importId === importId).map((s) => s.item).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const lines = new Map<ConstructKind, { count: number; pages: { itemId: string; path: string; urlId: string | null }[]; capped: boolean }>();
    const html: { itemId: string; path: string; urlId: string | null; fragments: number }[] = [];
    const note = (kind: ConstructKind, item: ImportItem, n: number): void => {
      const line = lines.get(kind) ?? { count: 0, pages: [], capped: false };
      line.count += n;
      if (line.pages.length < MAX_REPORT_PAGES) line.pages.push({ itemId: item.id, path: item.path, urlId: item.urlId });
      else line.capped = true;
      lines.set(kind, line);
    };
    for (const item of items) {
      if (item.status === 'ok') {
        const counts = this.written.find((w) => w.tenantId === tenantId && w.importId === importId && w.page.itemId === item.id)?.page.constructs ?? {};
        for (const kind of Object.keys(CONSTRUCT_FATES) as ConstructKind[]) {
          const n = counts[kind] ?? 0;
          if (n > 0) note(kind, item, n);
        }
        if ((counts.raw_html ?? 0) > 0) html.push({ itemId: item.id, path: item.path, urlId: item.urlId, fragments: counts.raw_html ?? 0 });
        if (item.kind === 'database_csv') note('database_table', item, 1);
      } else if (item.status === 'skipped' && item.message === 'database_row') note('database_row', item, 1);
    }
    return Promise.resolve({
      constructs: (Object.keys(CONSTRUCT_FATES) as ConstructKind[]).flatMap((kind) => { const line = lines.get(kind); return line === undefined ? [] : [{ kind, fate: CONSTRUCT_FATES[kind], ...line }]; }),
      rawHtmlPages: html.slice(0, MAX_REPORT_PAGES),
      rawHtmlCapped: html.length > MAX_REPORT_PAGES,
    });
  }

  markUploaded(tenantId: string, id: string): Promise<boolean> {
    const at = this.find(tenantId, id);
    const row = this.rows[at];
    if (row === undefined || (row.status !== 'created' && row.status !== 'uploaded')) return Promise.resolve(false);
    this.replace(at, { status: 'uploaded' });
    return Promise.resolve(true);
  }

  scanItems(tenantId: string, importId: string, options: { readonly afterId?: string; readonly limit: number }): Promise<readonly ImportItem[]> {
    const after = options.afterId === undefined ? -1n : BigInt(options.afterId);
    const items = this.stored.filter((s) => s.tenantId === tenantId && s.importId === importId && BigInt(s.item.id) > after).map((s) => s.item);
    return Promise.resolve(items.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).slice(0, options.limit));
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

  running(tenantId: string): Promise<readonly string[]> {
    return Promise.resolve(this.rows.filter((r) => r.tenantId === tenantId && r.status === 'running').map((r) => r.id));
  }

  stale(tenantId: string, createdBefore: number, limit: number): Promise<readonly string[]> {
    const old = this.rows
      .filter((r) => r.tenantId === tenantId && (r.status === 'created' || r.status === 'uploaded') && (this.createdAt.get(r.id) ?? Number.MAX_SAFE_INTEGER) <= createdBefore)
      .sort((a, b) => (this.createdAt.get(a.id) as number) - (this.createdAt.get(b.id) as number));
    return Promise.resolve(old.slice(0, limit).map((r) => r.id));
  }

  abandon(tenantId: string, id: string, now: number): Promise<boolean> {
    const at = this.find(tenantId, id);
    const status = this.rows[at]?.status;
    if (status !== 'created' && status !== 'uploaded') return Promise.resolve(false);
    this.replace(at, { status: 'failed', error: 'abandoned', finishedAt: now });
    return Promise.resolve(true);
  }

  abort(tenantId: string, id: string, now: number): Promise<boolean> {
    const at = this.find(tenantId, id);
    if (this.rows[at]?.status !== 'created') return Promise.resolve(false);
    this.replace(at, { status: 'failed', error: 'abandoned', finishedAt: now });
    return Promise.resolve(true);
  }

  ended(tenantId: string, options: { readonly since: number; readonly afterId?: string; readonly limit: number }): Promise<readonly ImportRecord[]> {
    const rows = this.rows
      .filter((r) => r.tenantId === tenantId && (r.status === 'done' || r.status === 'failed' || r.status === 'cancelled') && (r.finishedAt ?? 0) >= options.since && (options.afterId === undefined || r.id > options.afterId))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return Promise.resolve(rows.slice(0, options.limit));
  }

  /** The fake keeps the parent of each page it wrote: a page under another page of the import is part of that page's subtree, so the batches are the outermost roots, as in the database. A page a person added has nowhere to be here (the database case checks those). */
  trashImported(tenantId: string, id: string): Promise<{ readonly batches: readonly string[]; readonly pages: number } | undefined> {
    if (this.find(tenantId, id) === -1) return Promise.resolve(undefined);
    const live = this.stored.filter((s) => s.tenantId === tenantId && s.importId === id && (s.item.kind === 'page' || s.item.kind === 'database_csv') && s.item.status === 'ok' && s.item.pageId !== null && !this.trashed.has(s.item.pageId));
    const ids = new Set(live.map((s) => s.item.pageId as string));
    const parentOf = new Map(this.written.filter((w) => w.tenantId === tenantId && w.importId === id).map((w) => [this.stored.find((s) => s.tenantId === tenantId && s.importId === id && s.item.id === w.page.itemId)?.item.pageId ?? '', w.page.parentId]));
    const underAnother = (pageId: string): boolean => {
      for (let parent = parentOf.get(pageId) ?? null; parent !== null; parent = parentOf.get(parent) ?? null) if (ids.has(parent)) return true;
      return false;
    };
    for (const pageId of ids) this.trashed.add(pageId);
    return Promise.resolve({ batches: [...ids].filter((pageId) => !underAnother(pageId)), pages: ids.size });
  }
}
