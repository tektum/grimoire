import { randomUUID } from 'node:crypto';
import type { AccessEntry, AccessGrant, AccessList, CollectionPatch, CollectionRecord, CollectionRepo, NewCollection, UpdateResult, UpsertAccessResult } from '../ports/collection-repo.js';
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
  /** Test setup: display names of users and groups (the id is the name otherwise). */
  private mirrored: World['access'] = [];
  private written = new Set<World['access'][number]>();
  readonly names = new Map<string, string>();

  constructor(readonly world: World = emptyWorld(), readonly audit: FakeAuditLog = new FakeAuditLog()) {}

  /** Test setup: a collection that exists, also as a fact of the world. */
  seed(row: Omit<CollectionRecord, 'id'> & { id?: string }): CollectionRecord {
    const record: CollectionRecord = { ...row, id: row.id ?? randomUUID() };
    this.store(record);
    return record;
  }

  /** Test setup: the collection is deleted (the world still knows it, as deleted). */
  markDeleted(id: string): void {
    const fact = this.world.collections.find((c) => c.id === id);
    if (fact !== undefined) fact.deleted = true;
    this.rows.delete(id);
  }

  listLive(ids: readonly string[]): Promise<readonly CollectionRecord[]> {
    return Promise.resolve(this.live().filter((c) => ids.includes(c.id)));
  }

  get(id: string): Promise<CollectionRecord | undefined> {
    return Promise.resolve(this.rows.get(id));
  }

  append(input: NewCollection, positionAfter: (last: string | null) => string): Promise<CollectionRecord> {
    const last = this.live().at(-1);
    const record = this.seed({
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

  update(id: string, patch: CollectionPatch, actorId: string): Promise<UpdateResult> {
    const current = this.rows.get(id);
    if (current === undefined) return Promise.resolve({ kind: 'not-found' });
    if (patch.position !== undefined && this.live().some((c) => c.id !== id && c.position === patch.position)) return Promise.resolve({ kind: 'position-taken' });
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

  listAccess(collectionId: string): Promise<AccessList | undefined> {
    const c = this.rows.get(collectionId);
    if (c === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ defaultPermission: c.defaultPermission, entries: this.entries.filter((e) => e.collectionId === collectionId).map(visible) });
  }

  upsertAccess(collectionId: string, grant: AccessGrant, actorId: string): Promise<UpsertAccessResult> {
    if (!this.rows.has(collectionId)) return Promise.resolve({ kind: 'not-found' });
    const known = grant.principalType === 'user' ? this.world.users : this.world.groups;
    if (!known.some((p) => p.id === grant.principalId)) return Promise.resolve({ kind: 'no-principal' });
    const at = this.entries.findIndex((e) => e.collectionId === collectionId && e.principalType === grant.principalType && e.principalId === grant.principalId);
    const entry = { id: at < 0 ? randomUUID() : (this.entries[at] as AccessEntry).id, collectionId, ...grant, name: this.names.get(grant.principalId) ?? grant.principalId };
    if (at < 0) this.entries.push(entry);
    else this.entries[at] = entry;
    this.mirrorEntries();
    this.audit.events.push({ actorId, action: 'collection.access_upserted', targetType: 'collection', targetId: collectionId, detail: { ...grant } });
    return Promise.resolve({ kind: 'saved', entry: visible(entry) });
  }

  removeAccess(collectionId: string, entryId: string, actorId: string): Promise<boolean> {
    const at = this.entries.findIndex((e) => e.id === entryId && e.collectionId === collectionId);
    const entry = this.entries[at];
    if (entry === undefined || !this.rows.has(collectionId)) return Promise.resolve(false);
    this.entries.splice(at, 1);
    this.mirrorEntries();
    this.audit.events.push({
      actorId, action: 'collection.access_removed', targetType: 'collection', targetId: collectionId,
      detail: { principalType: entry.principalType, principalId: entry.principalId, permission: entry.permission },
    });
    return Promise.resolve(true);
  }

  /** Replaces only the world rows this repo wrote earlier; facts a test put into the world itself stay. */
  private mirrorEntries(): void {
    this.mirrored = this.entries.map((e) => ({ collectionId: e.collectionId, permission: e.permission, ...(e.principalType === 'user' ? { userId: e.principalId } : { groupId: e.principalId }) }));
    this.world.access = [...this.world.access.filter((a) => !this.written.has(a)), ...this.mirrored];
    this.written = new Set(this.mirrored);
  }

  private live(): CollectionRecord[] {
    return [...this.rows.values()].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  }

  private store(record: CollectionRecord): void {
    this.rows.set(record.id, record);
    const fact = { id: record.id, deleted: false, defaultPermission: record.defaultPermission, position: record.position };
    const at = this.world.collections.findIndex((c) => c.id === record.id);
    if (at < 0) this.world.collections.push(fact);
    else this.world.collections[at] = fact;
  }
}
