import { randomUUID } from 'node:crypto';
import type { AccessEntry, TreePage, AccessGrant, AccessList, CollectionPatch, CollectionRecord, CollectionRepo, NewCollection, UpdateResult, UpsertAccessResult } from '../ports/collection-repo.js';
import { emptyWorld } from './fake-access-store.js';
import type { World } from './fake-access-store.js';
import { FakeAuditLog } from './fake-audit-log.js';

const visible = (e: AccessEntry & { collectionId: string }): AccessEntry => ({ id: e.id, principalType: e.principalType, principalId: e.principalId, name: e.name, permission: e.permission });

/**
 * In-memory CollectionRepo for tests. The permission facts live in the `World` the fake access store reads, so a change made here is what
 * the next authorisation sees; names, text and positions are kept beside it. A byte-order position, as `COLLATE "C"` gives.
 */
export class FakeCollectionRepo implements CollectionRepo {
  private readonly rows = new Map<string, CollectionRecord>();
  private readonly entries: (AccessEntry & { collectionId: string })[] = [];
  private readonly pageRows: (TreePage & { collectionId: string; deleted: boolean; batch: string | null })[] = [];
  private mirrored: World['access'] = [];
  /** Principals whose entry was just removed: a row for them in the world goes too, as the one row of the table does. */
  private changed: World['access'] = [];
  private written = new Set<World['access'][number]>();
  /** Test setup: display names of users and groups (the id is the name otherwise). */
  readonly names = new Map<string, string>();
  /** Test setup: the tenant of a user or a group (`legacy` otherwise). */
  readonly principalTenants = new Map<string, string>();
  /** The tenant of each collection (`legacy` unless seeded with another). */
  private readonly tenants = new Map<string, string>();

  constructor(readonly world: World = emptyWorld(), readonly audit: FakeAuditLog = new FakeAuditLog()) {}

  /** Test setup: a collection that exists, also as a fact of the world. */
  seed(row: Omit<CollectionRecord, 'id'> & { id?: string; tenantId?: string }): CollectionRecord {
    const { tenantId, ...fields } = row;
    const record: CollectionRecord = { ...fields, id: row.id ?? randomUUID() };
    this.tenants.set(record.id, tenantId ?? 'legacy');
    this.store(record);
    return record;
  }

  /** Test setup: a live page of a collection, also as a fact of the world. */
  seedPage(row: Partial<TreePage> & { collectionId: string }): TreePage {
    const id = row.id ?? randomUUID();
    const page = { id, urlId: row.urlId ?? id.slice(0, 8), parentId: row.parentId ?? null, position: row.position ?? `p${String(this.pageRows.length).padStart(4, '0')}`, title: row.title ?? 'Page', icon: row.icon ?? null };
    this.pageRows.push({ ...page, collectionId: row.collectionId, deleted: false, batch: null });
    this.world.pages.push({ id, collectionId: row.collectionId, deleted: false, epoch: 0 });
    return page;
  }

  /** Test setup: the batch a page was deleted in (null for a live page). */
  batchOf(pageId: string): string | null | undefined {
    return this.pageRows.find((p) => p.id === pageId)?.batch;
  }

  /** Test setup: the collection is deleted (the world still knows it, as deleted). */
  markDeleted(id: string): void {
    const fact = this.world.collections.find((c) => c.id === id);
    if (fact !== undefined) fact.deleted = true;
    this.rows.delete(id);
  }

  private mine(tenantId: string, id: string): CollectionRecord | undefined {
    return this.tenants.get(id) === tenantId ? this.rows.get(id) : undefined;
  }

  private liveIn(tenantId: string): CollectionRecord[] {
    return this.live().filter((c) => this.tenants.get(c.id) === tenantId);
  }

  listLive(tenantId: string, ids: readonly string[]): Promise<readonly CollectionRecord[]> {
    return Promise.resolve(this.liveIn(tenantId).filter((c) => ids.includes(c.id)));
  }

  get(tenantId: string, id: string): Promise<CollectionRecord | undefined> {
    return Promise.resolve(this.mine(tenantId, id));
  }

  append(tenantId: string, input: NewCollection, positionAfter: (last: string | null) => string): Promise<CollectionRecord> {
    const last = this.liveIn(tenantId).at(-1);
    const record = this.seed({
      tenantId,
      name: input.name, description: input.description ?? null, icon: input.icon ?? null, color: input.color ?? null,
      position: positionAfter(last?.position ?? null), defaultPermission: input.defaultPermission ?? null,
    });
    if (record.defaultPermission !== null) {
      this.audit.events.push({
        actorId: input.createdBy, action: 'collection.default_permission_changed', targetType: 'collection', targetId: record.id,
        detail: { from: null, to: record.defaultPermission },
      });
    }
    return Promise.resolve(record);
  }

  update(tenantId: string, id: string, patch: CollectionPatch, actorId: string): Promise<UpdateResult> {
    const current = this.mine(tenantId, id);
    if (current === undefined) return Promise.resolve({ kind: 'not-found' });
    if (patch.position !== undefined && this.liveIn(tenantId).some((c) => c.id !== id && c.position === patch.position)) return Promise.resolve({ kind: 'position-taken' });
    const next: CollectionRecord = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.icon === undefined ? {} : { icon: patch.icon }),
      ...(patch.color === undefined ? {} : { color: patch.color }),
      ...(patch.position === undefined ? {} : { position: patch.position }),
      ...(patch.defaultPermission === undefined ? {} : { defaultPermission: patch.defaultPermission }),
    };
    this.store(next);
    if (next.defaultPermission !== current.defaultPermission) {
      this.audit.events.push({
        actorId, action: 'collection.default_permission_changed', targetType: 'collection', targetId: id,
        detail: { from: current.defaultPermission, to: next.defaultPermission },
      });
    }
    return Promise.resolve({ kind: 'updated', collection: next });
  }

  listAccess(tenantId: string, collectionId: string): Promise<AccessList | undefined> {
    const c = this.mine(tenantId, collectionId);
    if (c === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ defaultPermission: c.defaultPermission, entries: this.entries.filter((e) => e.collectionId === collectionId).map(visible) });
  }

  upsertAccess(tenantId: string, collectionId: string, grant: AccessGrant, actorId: string): Promise<UpsertAccessResult> {
    if (this.mine(tenantId, collectionId) === undefined) return Promise.resolve({ kind: 'not-found' });
    const known = grant.principalType === 'user' ? this.world.users : this.world.groups;
    if (!known.some((p) => p.id === grant.principalId) || (this.principalTenants.get(grant.principalId) ?? 'legacy') !== tenantId) return Promise.resolve({ kind: 'no-principal' });
    const previous = this.entries.find((e) => e.collectionId === collectionId && e.principalType === grant.principalType && e.principalId === grant.principalId)?.permission ?? null;
    const at = this.entries.findIndex((e) => e.collectionId === collectionId && e.principalType === grant.principalType && e.principalId === grant.principalId);
    const entry = { id: at < 0 ? randomUUID() : (this.entries[at] as AccessEntry).id, collectionId, ...grant, name: this.names.get(grant.principalId) ?? grant.principalId };
    if (at < 0) this.entries.push(entry);
    else this.entries[at] = entry;
    this.changed = [];
    this.mirrorEntries();
    this.audit.events.push({ actorId, action: 'collection.access_upserted', targetType: 'collection', targetId: collectionId, detail: { ...grant, entryId: entry.id, previousPermission: previous } });
    return Promise.resolve({ kind: 'saved', entry: visible(entry) });
  }

  removeAccess(tenantId: string, collectionId: string, entryId: string, actorId: string): Promise<boolean> {
    const at = this.entries.findIndex((e) => e.id === entryId && e.collectionId === collectionId);
    const entry = this.entries[at];
    if (entry === undefined || this.mine(tenantId, collectionId) === undefined) return Promise.resolve(false);
    this.entries.splice(at, 1);
    this.changed = [{ collectionId, permission: entry.permission, ...(entry.principalType === 'user' ? { userId: entry.principalId } : { groupId: entry.principalId }) }];
    this.mirrorEntries();
    this.audit.events.push({
      actorId, action: 'collection.access_removed', targetType: 'collection', targetId: collectionId,
      detail: { entryId: entry.id, principalType: entry.principalType, principalId: entry.principalId, permission: entry.permission },
    });
    return Promise.resolve(true);
  }

  tree(tenantId: string, collectionId: string): Promise<readonly TreePage[] | undefined> {
    if (this.mine(tenantId, collectionId) === undefined) return Promise.resolve(undefined);
    const pages = this.pageRows.filter((p) => p.collectionId === collectionId && !p.deleted).sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return Promise.resolve(pages.map(({ id, urlId, parentId, position, title, icon }) => ({ id, urlId, parentId, position, title, icon })));
  }

  softDelete(tenantId: string, collectionId: string, actorId: string): Promise<{ readonly batch: string; readonly pages: number } | undefined> {
    if (this.mine(tenantId, collectionId) === undefined) return Promise.resolve(undefined);
    const batch = randomUUID();
    const live = this.pageRows.filter((p) => p.collectionId === collectionId && !p.deleted);
    for (const page of live) {
      page.deleted = true;
      page.batch = batch;
      const fact = this.world.pages.find((w) => w.id === page.id);
      if (fact !== undefined) fact.deleted = true;
    }
    this.markDeleted(collectionId);
    this.audit.events.push({ actorId, action: 'collection.deleted', targetType: 'collection', targetId: collectionId, detail: { batch, pages: live.length } });
    return Promise.resolve({ batch, pages: live.length });
  }

  /** Replaces only the world rows this repo wrote earlier; facts a test put into the world itself stay. */
  private mirrorEntries(): void {
    this.mirrored = this.entries.map((e) => ({ collectionId: e.collectionId, permission: e.permission, ...(e.principalType === 'user' ? { userId: e.principalId } : { groupId: e.principalId }) }));
    const same = (a: World['access'][number], b: World['access'][number]): boolean => a.collectionId === b.collectionId && a.userId === b.userId && a.groupId === b.groupId;
    const touched = [...this.mirrored, ...this.changed];
    this.world.access = [...this.world.access.filter((a) => !this.written.has(a) && !touched.some((m) => same(a, m))), ...this.mirrored];
    this.written = new Set(this.mirrored);
  }

  private live(): CollectionRecord[] {
    return [...this.rows.values()].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  }

  private store(record: CollectionRecord): void {
    this.rows.set(record.id, record);
    // The permission facts name a tenant only when it is not legacy, as the page facts of the page fake do: the rule compares the person's tenant with the collection's, and a fact with none is legacy.
    const tenant = this.tenants.get(record.id) ?? 'legacy';
    const fact = { id: record.id, deleted: false, defaultPermission: record.defaultPermission, position: record.position, ...(tenant === 'legacy' ? {} : { tenantId: tenant }) };
    const at = this.world.collections.findIndex((c) => c.id === record.id);
    if (at < 0) this.world.collections.push(fact);
    else this.world.collections[at] = fact;
  }
}
