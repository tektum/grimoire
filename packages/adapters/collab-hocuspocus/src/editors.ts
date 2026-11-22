/** Who edited a page since its last stored save (R4.22). Only the latest editor is persisted; the set is kept so that a later version can record every editor. */
export interface EditRecord {
  readonly users: ReadonlySet<string>;
  readonly latest: string | undefined;
  /** Clock value when the latest change arrived. */
  readonly at: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `last_edited_by` is a `uuid` column: a development token's user id is a name, not a UUID, and is recorded as no editor. */
export const editorColumn = (userId: string | undefined): string | undefined => (userId !== undefined && UUID.test(userId) ? userId : undefined);

export interface EditorTracker {
  /** A change arrived on `pageId` from `userId` (undefined: unknown connection) at `at`. */
  record(pageId: string, userId: string | undefined, at: number): void;
  /** Returns and clears the record: called before a write. */
  take(pageId: string): EditRecord | undefined;
  /** Puts a taken record back (the write failed or did not store the editor). A change that arrived meanwhile is newer and stays the latest. */
  restore(pageId: string, rec: EditRecord): void;
  forget(pageId: string): void;
}

export function createEditorTracker(): EditorTracker {
  const records = new Map<string, EditRecord>();
  return {
    record(pageId, userId, at) {
      const users = new Set(records.get(pageId)?.users);
      if (userId !== undefined) users.add(userId);
      records.set(pageId, { users, latest: userId, at });
    },
    take(pageId) {
      const rec = records.get(pageId);
      records.delete(pageId);
      return rec;
    },
    restore(pageId, rec) {
      const newer = records.get(pageId);
      if (newer === undefined) { records.set(pageId, rec); return; }
      records.set(pageId, { users: new Set([...rec.users, ...newer.users]), latest: newer.latest, at: newer.at });
    },
    forget(pageId) { records.delete(pageId); },
  };
}
