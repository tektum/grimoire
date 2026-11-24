import type { Queryable } from './database.js';

/** One stored attachment (a row of `attachments`), with times as epoch milliseconds and the size as a number. */
export interface AttachmentRow {
  readonly id: string;
  readonly pageId: string;
  /** Null once the uploader's account is gone (the row stays). */
  readonly uploaderId: string | null;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  /** The object key in the file store. */
  readonly key: string;
  /** The tenant of the row (docs/tenancy.md); absent only in tests that do not use tenants. */
  readonly tenantId?: string;
  readonly status: 'pending' | 'ready';
  /** Pending rows only: when the row and its object may be cleaned up. */
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly readyAt: number | null;
}

export interface NewPending {
  readonly id: string;
  readonly pageId: string;
  readonly uploaderId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly key: string;
  readonly tenantId?: string;
  readonly expiresAt: number;
}

/** A row that is `ready` from the start: what an importer stores, with no upload to wait for. */
export interface NewReady {
  readonly id: string;
  readonly pageId: string;
  readonly uploaderId: string | null;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly key: string;
  readonly readyAt: number;
}

/** `cap`: the user already has `cap` pending uploads that have not expired; `no-page`: the page is not there; `no-user`: the uploader is not there. */
export type CreatePendingResult = { kind: 'created'; row: AttachmentRow } | { kind: 'cap' } | { kind: 'no-page' } | { kind: 'no-user' };

/** Attachments: the rows. The objects are the file store's. */
export interface AttachmentRepo {
  /**
   * Inserts a pending row only when the uploader has fewer than `cap` pending rows whose `expiresAt` is after `now` (expired ones do not count), and decides it
   * atomically: parallel creates by one user never exceed the cap.
   */
  createPending(input: NewPending, cap: number, now: number): Promise<CreatePendingResult>;
  get(id: string): Promise<AttachmentRow | undefined>;
  /** The rows that exist among `ids`, in no particular order. */
  getMany(ids: readonly string[]): Promise<readonly AttachmentRow[]>;
  /** Pending to ready: `readyAt` is `now`, `expiresAt` is null. Undefined when the row is not pending (already ready, or gone) or has expired by `now`: an expired upload never completes, so a clean-up that has begun cannot lose an object to a completion that is still under way. */
  markReady(id: string, now: number): Promise<AttachmentRow | undefined>;
  /** Deletes a row whatever its state (an upload that was refused). */
  remove(id: string): Promise<void>;
  /** Deletes a row only while it is still pending, so a clean-up cannot remove an upload that completed in the meantime. False when it was not. */
  removeIfPending(id: string): Promise<boolean>;
  /** Pending rows that expired before `now`, oldest first, at most `limit`. */
  expiredPending(now: number, limit: number): Promise<readonly AttachmentRow[]>;
  /** Stores a ready row, inside the caller's transaction when `tx` is given, so it commits or rolls back with the page the importer is writing. */
  insertReady(row: NewReady, tx?: Queryable): Promise<AttachmentRow>;
}
