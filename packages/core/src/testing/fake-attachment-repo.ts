import type { AttachmentRepo, AttachmentRow, CreatePendingResult, NewPending, NewReady } from '../ports/attachment-repo.js';

/** A row is in the tenant it names (`legacy` when it names none), as the table's `tenant_id` and the scoped statements decide. */
const inTenant = (r: AttachmentRow, tenantId: string): boolean => (r.tenantId ?? 'legacy') === tenantId;

/** In-memory AttachmentRepo for tests. `pages` and `users` say which ids exist (every id does when omitted), as the foreign keys of the table do. */
export class FakeAttachmentRepo implements AttachmentRepo {
  private rows: AttachmentRow[] = [];

  constructor(private readonly exists: { pages?: (id: string) => boolean; users?: (id: string) => boolean } = {}) {}

  /** Test setup: a row as it is, whatever its state. */
  seed(row: AttachmentRow): AttachmentRow {
    this.rows.push(row);
    return row;
  }

  all(): readonly AttachmentRow[] {
    return [...this.rows];
  }

  createPending(input: NewPending, cap: number, now: number): Promise<CreatePendingResult> {
    if (this.exists.users?.(input.uploaderId) === false) return Promise.resolve({ kind: 'no-user' });
    const live = this.rows.filter((r) => r.uploaderId === input.uploaderId && r.status === 'pending' && r.expiresAt !== null && r.expiresAt > now).length;
    if (live >= cap) return Promise.resolve({ kind: 'cap' });
    if (this.exists.pages?.(input.pageId) === false) return Promise.resolve({ kind: 'no-page' });
    const row: AttachmentRow = {
      id: input.id, pageId: input.pageId, uploaderId: input.uploaderId, fileName: input.fileName, contentType: input.contentType, size: input.size, key: input.key, tenantId: input.tenantId,
      status: 'pending', expiresAt: input.expiresAt, createdAt: now, readyAt: null,
    };
    this.rows.push(row);
    return Promise.resolve({ kind: 'created', row });
  }

  get(tenantId: string, id: string): Promise<AttachmentRow | undefined> {
    return Promise.resolve(this.rows.find((r) => r.id === id && inTenant(r, tenantId)));
  }

  getMany(tenantId: string, ids: readonly string[]): Promise<readonly AttachmentRow[]> {
    return Promise.resolve(this.rows.filter((r) => ids.includes(r.id) && inTenant(r, tenantId)));
  }

  markReady(tenantId: string, id: string, now: number): Promise<AttachmentRow | undefined> {
    const index = this.rows.findIndex((r) => r.id === id && inTenant(r, tenantId) && r.status === 'pending' && r.expiresAt !== null && r.expiresAt > now);
    if (index < 0) return Promise.resolve(undefined);
    const ready: AttachmentRow = { ...(this.rows[index] as AttachmentRow), status: 'ready', readyAt: now, expiresAt: null };
    this.rows[index] = ready;
    return Promise.resolve(ready);
  }

  remove(tenantId: string, id: string): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.id === id && inTenant(r, tenantId)));
    return Promise.resolve();
  }

  removeIfPending(tenantId: string, id: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.id === id && inTenant(r, tenantId) && r.status === 'pending'));
    return Promise.resolve(this.rows.length < before);
  }

  expiredPending(tenantId: string, now: number, limit: number): Promise<readonly AttachmentRow[]> {
    return Promise.resolve(
      this.rows.filter((r) => inTenant(r, tenantId) && r.status === 'pending' && r.expiresAt !== null && r.expiresAt < now).sort((a, b) => (a.expiresAt as number) - (b.expiresAt as number)).slice(0, limit),
    );
  }

  insertReady(row: NewReady): Promise<AttachmentRow> {
    const stored: AttachmentRow = {
      id: row.id, pageId: row.pageId, uploaderId: row.uploaderId, fileName: row.fileName, contentType: row.contentType, size: row.size, key: row.key, tenantId: 'legacy',
      status: 'ready', expiresAt: null, createdAt: row.readyAt, readyAt: row.readyAt,
    };
    this.rows.push(stored);
    return Promise.resolve(stored);
  }
}
