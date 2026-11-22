/**
 * What the host keeps per connection: `address` and `peerId` from the upgrade, the rest set by `onAuthenticate` (contracts section 2).
 * `userId` is `users.id` (the database row), never the token subject; `descopeUserId` is the subject, kept for the session re-check.
 * The token itself is never kept (R4.8).
 */
export interface ConnectionContext {
  address: string;
  peerId: string;
  userId?: string;
  descopeUserId?: string;
  accessLevel?: 'read-write' | 'read-only';
  expiresAt?: number;
  /** `state_epoch` of the page when access was decided; the re-check closes the connection when it changes. */
  epoch?: number;
}

/** Hocuspocus hands contexts over as `any`; this is the one place that narrows them. */
export function readContext(value: unknown): Partial<ConnectionContext> {
  if (typeof value !== 'object' || value === null) return {};
  const v = value as Record<string, unknown>;
  const out: Partial<ConnectionContext> = {};
  if (typeof v['address'] === 'string') out.address = v['address'];
  if (typeof v['peerId'] === 'string') out.peerId = v['peerId'];
  if (typeof v['userId'] === 'string') out.userId = v['userId'];
  if (typeof v['descopeUserId'] === 'string') out.descopeUserId = v['descopeUserId'];
  if (v['accessLevel'] === 'read-write' || v['accessLevel'] === 'read-only') out.accessLevel = v['accessLevel'];
  if (typeof v['expiresAt'] === 'number') out.expiresAt = v['expiresAt'];
  if (typeof v['epoch'] === 'number') out.epoch = v['epoch'];
  return out;
}

/** Applies a change to the per-document context in place: Hocuspocus keeps the object it created, and later hooks read that same one. */
export function updateContext(value: unknown, patch: Partial<Pick<ConnectionContext, 'expiresAt'>>): void {
  if (typeof value === 'object' && value !== null) Object.assign(value, patch);
}

