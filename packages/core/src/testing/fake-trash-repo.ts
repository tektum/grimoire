import { randomUUID } from 'node:crypto';
import type { PageMeta, TenantPageLimits } from '../ports/page-repo.js';
import type { RestoreResult, TrashCursor, TrashRepo, TrashRoot, TrashRootInfo } from '../ports/trash-repo.js';
import { FakeAuditLog } from './fake-audit-log.js';
import { emptyWorld } from './fake-access-store.js';
import type { World } from './fake-access-store.js';

interface Row {
  id: string;
  tenantId: string;
  collectionId: string;
  parentId: string | null;
  position: string;
  title: string;
  deletedAt: number | null;
  deletedBy: string | null;
  batch: string | null;
  attachments: string[];
}

export interface FakePage {
  readonly id?: string;
  readonly collectionId: string;
  /** The tenant of the page (legacy when unset). */
  readonly tenantId?: string;
  readonly parentId?: string | null;
  readonly position?: string;
  readonly title?: string;
  /** Deleted pages only: the batch (its own id when unset), the time and the user. */
  readonly batch?: string;
  readonly deletedAt?: number;
  readonly deletedBy?: string;
  /** Object keys of the page's attachments. */
  readonly attachments?: readonly string[];
}

/** In-memory TrashRepo for tests. Pages here are the trash's own; the `World` carries the facts the access checks read. A page of another tenant is absent. */
export class FakeTrashRepo implements TrashRepo {
  private readonly rows: Row[] = [];
  private readonly deletedKeys = new Set<string>();
  /** Test setup: runs inside `restore` before the collection is compared, to play a move that lands after the caller was checked. */
  beforeRestore: (() => void) | undefined;

  constructor(
    readonly world: World = emptyWorld(),
    readonly audit: FakeAuditLog = new FakeAuditLog(),
  ) {}

  /** Test setup: a live page. */
  seedLive(page: FakePage): string {
    return this.add(page, false);
  }

  /** Test setup: a deleted page in a batch of its own unless `batch` is given. */
  seedDeleted(page: FakePage): string {
    return this.add(page, true);
  }

  /** Whether a page row is still there (live or deleted), and whether it is deleted. */
  state(id: string): 'live' | 'deleted' | 'gone' {
    const row = this.rows.find((r) => r.id === id);
    return row === undefined ? 'gone' : row.deletedAt === null ? 'live' : 'deleted';
  }

  /** Test setup: puts a page (deleted or live) in another collection, as a move of an ancestor does. */
  relocate(id: string, collectionId: string): void {
    const row = this.rows.find((r) => r.id === id);
    if (row !== undefined) row.collectionId = collectionId;
  }

  /** Whether an attachment object key has been marked deleted by a purge that found its page live again. */
  keyDeleted(key: string): boolean {
    return this.deletedKeys.has(key);
  }

  private add(page: FakePage, deleted: boolean): string {
    const id = page.id ?? randomUUID();
    const tenantId = page.tenantId ?? 'legacy';
    this.rows.push({
      id,
      tenantId,
      collectionId: page.collectionId,
      parentId: page.parentId ?? null,
      position: page.position ?? `p${String(this.rows.length).padStart(5, '0')}`,
      title: page.title ?? '',
      deletedAt: deleted ? (page.deletedAt ?? 1000) : null,
      deletedBy: deleted ? (page.deletedBy ?? null) : null,
      batch: deleted ? (page.batch ?? id) : null,
      attachments: [...(page.attachments ?? [])],
    });
    this.world.pages.push({ id, collectionId: page.collectionId, deleted, epoch: 0, ...(tenantId === 'legacy' ? {} : { tenantId }) });
    return id;
  }

  private isRoot(row: Row): boolean {
    if (row.deletedAt === null) return false;
    const parent = row.parentId === null ? undefined : this.rows.find((r) => r.id === row.parentId);
    return parent === undefined || parent.batch !== row.batch;
  }

  roots(tenantId: string, collectionIds: readonly string[] | null, limit: number, after?: TrashCursor): Promise<readonly TrashRoot[]> {
    const rows = this.rows
      .filter((r) => r.tenantId === tenantId && this.isRoot(r) && (collectionIds === null || collectionIds.includes(r.collectionId)))
      .sort((a, b) => (b.deletedAt as number) - (a.deletedAt as number) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .filter((r) => after === undefined || (r.deletedAt as number) < after.deletedAt || ((r.deletedAt as number) === after.deletedAt && r.id < after.id));
    return Promise.resolve(
      rows.slice(0, limit).map((r) => ({ id: r.id, title: r.title, collectionId: r.collectionId, deletedAt: r.deletedAt as number, deletedBy: r.deletedBy })),
    );
  }

  rootOf(tenantId: string, id: string): Promise<TrashRootInfo | undefined> {
    const row = this.rows.find((r) => r.id === id && r.tenantId === tenantId);
    if (row === undefined || !this.isRoot(row)) return Promise.resolve(undefined);
    const collectionDeleted = this.world.collections.find((c) => c.id === row.collectionId)?.deleted === true;
    return Promise.resolve({ id, collectionId: row.collectionId, batch: row.batch as string, collectionDeleted });
  }

  /** The rows of a batch and every row below them, transitively: what a purge of the batch removes. */
  private purgeSet(batch: string): Row[] {
    const out = this.rows.filter((r) => r.batch === batch);
    for (let i = 0; i < out.length; i++) out.push(...this.rows.filter((r) => r.parentId === out[i]?.id && !out.includes(r)));
    return out;
  }

  private depthAbove(parent: Row | undefined): number {
    let depth = 0;
    for (let up = parent; up !== undefined; up = this.rows.find((r) => r.id === up?.parentId)) depth += 1;
    return depth;
  }

  private heightBelow(root: Row, batch: Row[]): number {
    const down = (row: Row): number => 1 + Math.max(0, ...batch.filter((r) => r.parentId === row.id).map(down));
    return down(root);
  }

  restore(tenantId: string, id: string, expectedCollectionId: string, limits: TenantPageLimits, position: (before: string | null, after: string | null) => string): Promise<RestoreResult> {
    this.beforeRestore?.();
    const root = this.rows.find((r) => r.id === id && r.tenantId === tenantId);
    if (root === undefined || !this.isRoot(root)) return Promise.resolve({ kind: 'not-found' });
    if (root.collectionId !== expectedCollectionId) return Promise.resolve({ kind: 'conflict' });
    if (this.world.collections.find((c) => c.id === root.collectionId)?.deleted === true) return Promise.resolve({ kind: 'collection-deleted' });
    const batch = this.rows.filter((r) => r.batch === root.batch);
    const live = this.rows.filter((r) => r.deletedAt === null && r.collectionId === root.collectionId);
    if (live.length + batch.length > limits.maxPages) return Promise.resolve({ kind: 'collection-full' });
    if (this.rows.filter((r) => r.deletedAt === null && r.tenantId === tenantId).length + batch.length > limits.maxTenantPages) return Promise.resolve({ kind: 'tenant-pages-full' });
    const parent = root.parentId === null ? undefined : live.find((r) => r.id === root.parentId);
    // A parent that is gone or deleted, or under which the batch would be deeper than allowed, sends the root to the top level.
    const unavailable = root.parentId !== null && (parent === undefined || this.depthAbove(parent) + this.heightBelow(root, batch) > limits.maxDepth);
    const siblings = live
      .filter((r) => r.parentId === (unavailable ? null : root.parentId))
      .map((r) => r.position)
      .sort();
    if (unavailable) {
      root.parentId = null;
      root.position = position(null, siblings[0] ?? null);
    } else if (siblings.includes(root.position)) {
      root.position = position(siblings[siblings.length - 1] ?? null, null);
    }
    for (const row of batch) {
      row.deletedAt = null;
      row.deletedBy = null;
      row.batch = null;
      const fact = this.world.pages.find((p) => p.id === row.id);
      if (fact !== undefined) fact.deleted = false;
    }
    const page: PageMeta = {
      id,
      urlId: id.slice(0, 8),
      collectionId: root.collectionId,
      parentId: root.parentId,
      position: root.position,
      title: root.title,
      icon: null,
      createdBy: randomUUID(),
      lastEditedBy: null,
      lastEditedAt: null,
      savedAt: 0,
      stateEpoch: 0,
    };
    return Promise.resolve({ kind: 'restored', page });
  }

  attachmentKeys(tenantId: string, batch: string): Promise<readonly string[]> {
    return Promise.resolve(this.purgeSet(batch).filter((r) => r.tenantId === tenantId).flatMap((r) => r.attachments));
  }

  markFilesRemoved(tenantId: string, keys: readonly string[]): Promise<void> {
    for (const row of this.rows) if (row.tenantId === tenantId) for (const key of row.attachments) if (keys.includes(key)) this.deletedKeys.add(key);
    return Promise.resolve();
  }

  expiredBatches(tenantId: string, deletedBefore: number, limit: number): Promise<readonly string[]> {
    const oldest = new Map<string, number>();
    for (const r of this.rows) {
      if (r.tenantId !== tenantId || r.deletedAt === null || r.batch === null || r.deletedAt >= deletedBefore) continue;
      oldest.set(r.batch, Math.min(r.deletedAt, oldest.get(r.batch) ?? Infinity));
    }
    return Promise.resolve([...oldest].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([batch]) => batch));
  }

  purge(tenantId: string, batch: string, actorId: string, removedKeys: readonly string[]): Promise<{ pages: number }> {
    const gone = this.purgeSet(batch).filter((r) => r.tenantId === tenantId);
    for (const row of gone) {
      this.rows.splice(this.rows.indexOf(row), 1);
      const at = this.world.pages.findIndex((p) => p.id === row.id);
      if (at >= 0) this.world.pages.splice(at, 1);
    }
    // Objects already removed whose page is still there (a restore came in between): mark them, so no live page keeps a row for a missing object.
    for (const row of this.rows) for (const key of row.attachments) if (removedKeys.includes(key)) this.deletedKeys.add(key);
    if (gone.length === 0) return Promise.resolve({ pages: 0 });
    this.audit.events.push({ actorId, action: 'page.purged', targetType: 'page', targetId: batch, detail: { batch, pages: gone.length }, tenantId });
    return Promise.resolve({ pages: gone.length });
  }
}
