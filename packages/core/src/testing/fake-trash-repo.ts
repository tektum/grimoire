import { randomUUID } from 'node:crypto';
import type { PageLimits, PageMeta } from '../ports/page-repo.js';
import type { RestoreResult, TrashCursor, TrashRepo, TrashRoot, TrashRootInfo } from '../ports/trash-repo.js';
import { FakeAuditLog } from './fake-audit-log.js';
import { emptyWorld } from './fake-access-store.js';
import type { World } from './fake-access-store.js';

interface Row {
  id: string;
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

/** In-memory TrashRepo for tests. Pages here are the trash's own; the `World` carries the facts the access checks read. */
export class FakeTrashRepo implements TrashRepo {
  private readonly rows: Row[] = [];

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

  private add(page: FakePage, deleted: boolean): string {
    const id = page.id ?? randomUUID();
    this.rows.push({
      id,
      collectionId: page.collectionId,
      parentId: page.parentId ?? null,
      position: page.position ?? `p${String(this.rows.length).padStart(5, '0')}`,
      title: page.title ?? '',
      deletedAt: deleted ? (page.deletedAt ?? 1000) : null,
      deletedBy: deleted ? (page.deletedBy ?? null) : null,
      batch: deleted ? (page.batch ?? id) : null,
      attachments: [...(page.attachments ?? [])],
    });
    this.world.pages.push({ id, collectionId: page.collectionId, deleted, epoch: 0 });
    return id;
  }

  private isRoot(row: Row): boolean {
    if (row.deletedAt === null) return false;
    const parent = row.parentId === null ? undefined : this.rows.find((r) => r.id === row.parentId);
    return parent === undefined || parent.batch !== row.batch;
  }

  roots(collectionIds: readonly string[] | null, limit: number, after?: TrashCursor): Promise<readonly TrashRoot[]> {
    const rows = this.rows
      .filter((r) => this.isRoot(r) && (collectionIds === null || collectionIds.includes(r.collectionId)))
      .sort((a, b) => (b.deletedAt as number) - (a.deletedAt as number) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .filter((r) => after === undefined || (r.deletedAt as number) < after.deletedAt || ((r.deletedAt as number) === after.deletedAt && r.id < after.id));
    return Promise.resolve(
      rows.slice(0, limit).map((r) => ({ id: r.id, title: r.title, collectionId: r.collectionId, deletedAt: r.deletedAt as number, deletedBy: r.deletedBy })),
    );
  }

  rootOf(id: string): Promise<TrashRootInfo | undefined> {
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined || !this.isRoot(row)) return Promise.resolve(undefined);
    const collectionDeleted = this.world.collections.find((c) => c.id === row.collectionId)?.deleted === true;
    return Promise.resolve({ id, collectionId: row.collectionId, batch: row.batch as string, collectionDeleted });
  }

  restore(id: string, limits: PageLimits, position: (before: string | null, after: string | null) => string): Promise<RestoreResult> {
    const root = this.rows.find((r) => r.id === id);
    if (root === undefined || !this.isRoot(root)) return Promise.resolve({ kind: 'not-found' });
    if (this.world.collections.find((c) => c.id === root.collectionId)?.deleted === true) return Promise.resolve({ kind: 'collection-deleted' });
    const batch = this.rows.filter((r) => r.batch === root.batch);
    const live = this.rows.filter((r) => r.deletedAt === null && r.collectionId === root.collectionId);
    if (live.length + batch.length > limits.maxPages) return Promise.resolve({ kind: 'collection-full' });
    const parent = root.parentId === null ? undefined : live.find((r) => r.id === root.parentId);
    const siblings = live
      .filter((r) => r.parentId === (parent?.id ?? null))
      .map((r) => r.position)
      .sort();
    if (parent === undefined) {
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

  attachmentKeys(batch: string): Promise<readonly string[]> {
    return Promise.resolve(this.rows.filter((r) => r.batch === batch).flatMap((r) => r.attachments));
  }

  purge(batch: string, actorId: string): Promise<{ pages: number }> {
    const gone = this.rows.filter((r) => r.batch === batch);
    if (gone.length === 0) return Promise.resolve({ pages: 0 });
    for (const row of gone) {
      this.rows.splice(this.rows.indexOf(row), 1);
      const at = this.world.pages.findIndex((p) => p.id === row.id);
      if (at >= 0) this.world.pages.splice(at, 1);
    }
    this.audit.events.push({ actorId, action: 'page.purged', targetType: 'page', targetId: batch, detail: { batch, pages: gone.length } });
    return Promise.resolve({ pages: gone.length });
  }
}
