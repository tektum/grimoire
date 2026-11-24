import type { AttachmentRepo, AttachmentRow } from '../ports/attachment-repo.js';
import { FileStorageError } from '../ports/file-storage.js';
import type { FileStorage } from '../ports/file-storage.js';
import { cleanFileName } from './file-name.js';
import { attachmentKey, markdownPathFor } from './key.js';
import { isCheckedType, isInlineType, validateAttachmentMeta } from './validate.js';
import type { AttachmentLimits } from './validate.js';

/** The seconds a signed upload works, and the milliseconds a pending row waits for its upload to be completed (then it may be cleaned up). */
export const UPLOAD_TTL_SECONDS = 600;
export const PENDING_TTL_MS = 3_600_000;
/** How many bytes of the object are read to compare its real type with the declared one. */
export const SNIFF_BYTES = 512;

export interface AttachmentDeps {
  readonly repo: AttachmentRepo;
  readonly files: FileStorage;
  readonly now: () => number;
  /** A new id for an attachment (a UUID v7 in production). */
  readonly newId: () => string;
  /** The media type the first bytes of a file show, or undefined when they show none that is known. */
  readonly sniff: (bytes: Uint8Array) => Promise<string | undefined>;
}

export interface SignedUpload { readonly method: 'PUT'; readonly url: string; readonly headers: Record<string, string>; readonly expiresAt: number }

export type CreateRefusal = 'type_not_allowed' | 'too_large' | 'invalid' | 'rate_limited' | 'no-page' | 'no-user';
export type CreateResult =
  | { readonly kind: 'created'; readonly id: string; readonly upload: SignedUpload; readonly markdownPath: string }
  | { readonly kind: 'refused'; readonly reason: CreateRefusal };

/** The signed PUT of a key: the exact size and type, create-only, and a download disposition for everything a browser would not show inline. */
const sign = (d: AttachmentDeps, row: Pick<AttachmentRow, 'key' | 'size' | 'contentType'>, ttlSeconds: number = UPLOAD_TTL_SECONDS): Promise<SignedUpload> =>
  d.files.signUpload(row.key, {
    size: row.size, contentType: row.contentType, ttlSeconds, ifNoneMatch: true,
    ...(isInlineType(row.contentType) ? {} : { disposition: 'attachment' as const }),
  });

/**
 * The first step of an upload: the type and size are checked (type first), the pending row is inserted (refused at the user's cap), and the upload is signed.
 * When signing fails the row is removed again, so a store that is down does not use up the user's pending uploads.
 */
export async function createUpload(
  d: AttachmentDeps,
  input: { readonly pageId: string; readonly uploaderId: string; readonly fileName: string; readonly contentType: string; readonly size: number; readonly tenantId?: string },
  limits: AttachmentLimits & { readonly pendingMaxPerUser: number },
): Promise<CreateResult> {
  const meta = validateAttachmentMeta(input, limits);
  if (!meta.ok) return { kind: 'refused', reason: meta.reason };
  if (!Number.isSafeInteger(input.size) || input.size <= 0) return { kind: 'refused', reason: 'invalid' };
  const id = d.newId();
  const now = d.now();
  const created = await d.repo.createPending(
    { id, pageId: input.pageId, uploaderId: input.uploaderId, fileName: cleanFileName(input.fileName), contentType: input.contentType.toLowerCase(), size: input.size, key: attachmentKey(id, input.tenantId), ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }), expiresAt: now + PENDING_TTL_MS },
    limits.pendingMaxPerUser,
    now,
  );
  if (created.kind === 'cap') return { kind: 'refused', reason: 'rate_limited' };
  if (created.kind !== 'created') return { kind: 'refused', reason: created.kind };
  try {
    return { kind: 'created', id, upload: await sign(d, created.row), markdownPath: markdownPathFor(id, created.row.fileName) };
  } catch (error) {
    await d.repo.remove(id);
    throw error;
  }
}

/** The path of an attachment as an editor writes it, from its row. */
export const markdownPathOf = (row: Pick<AttachmentRow, 'id' | 'fileName'>): string => markdownPathFor(row.id, row.fileName);

/**
 * A retry of a create with the same Idempotency-Key: while the row is still pending and has not expired, a fresh upload URL is signed (a stored one may have
 * expired, and a URL is never stored), for no longer than the row has left, so no upload can land after the clean-up has removed the row; after that the answer is `gone`. Only the uploader's own row answers.
 */
export async function resignUpload(d: AttachmentDeps, id: string, userId: string, tenantId?: string): Promise<{ readonly kind: 'resigned'; readonly upload: SignedUpload; readonly markdownPath: string } | { readonly kind: 'gone' }> {
  const row = await d.repo.get(id);
  if (row === undefined || row.tenantId !== tenantId || row.uploaderId !== userId || row.status !== 'pending' || row.expiresAt === null || row.expiresAt <= d.now()) return { kind: 'gone' };
  const left = Math.floor((row.expiresAt - d.now()) / 1000);
  if (left < 1) return { kind: 'gone' };
  return { kind: 'resigned', upload: await sign(d, row, Math.min(UPLOAD_TTL_SECONDS, left)), markdownPath: markdownPathOf(row) };
}

/** The row an upload may be completed through: the caller's own, and either ready already or pending and not expired. Anything else is not found. */
export async function findUploadOf(d: AttachmentDeps, id: string, userId: string, tenantId?: string): Promise<AttachmentRow | undefined> {
  const row = await d.repo.get(id);
  if (row === undefined || row.tenantId !== tenantId || row.uploaderId !== userId) return undefined;
  if (row.status === 'pending' && (row.expiresAt === null || row.expiresAt <= d.now())) return undefined;
  return row;
}

export type CompleteRefusal = 'upload_missing' | 'size_mismatch' | 'type_mismatch';
export type CompleteResult =
  | { readonly kind: 'ready'; readonly row: AttachmentRow }
  | { readonly kind: 'refused'; readonly reason: CompleteRefusal }
  | { readonly kind: 'gone' };

/**
 * An upload that must not stay: the row goes first, and only while it is still pending; then the object. A row that became ready in the meantime (another completion
 * finished) is kept with its object and answered as ready, and one that is gone is gone.
 */
async function discard(d: AttachmentDeps, row: AttachmentRow, reason: CompleteRefusal): Promise<CompleteResult> {
  if (await d.repo.removeIfPending(row.id)) {
    await d.files.delete(row.key);
    return { kind: 'refused', reason };
  }
  const now = await d.repo.get(row.id);
  return now?.status === 'ready' ? { kind: 'ready', row: now } : { kind: 'gone' };
}

async function firstBytes(d: AttachmentDeps, key: string): Promise<Uint8Array> {
  const part = await d.files.get(key, { range: { start: 0, end: SNIFF_BYTES - 1 } });
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of part.body) {
    chunks.push(chunk);
    length += chunk.length;
    if (length >= SNIFF_BYTES) break;
  }
  const out = new Uint8Array(Math.min(length, SNIFF_BYTES));
  let at = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - at);
    out.set(chunk.subarray(0, take), at);
    at += take;
  }
  return out;
}

/**
 * The second step: the object must be there with the declared size, and for the raster types and PDF its first bytes must show the declared type (R9.22; other
 * types are protected by how they are served). A refusal deletes the object and the row. Completing a ready upload answers with the same row (idempotent). The
 * caller has already checked access and used `findUploadOf`.
 */
export async function completeUpload(d: AttachmentDeps, row: AttachmentRow): Promise<CompleteResult> {
  if (row.status === 'ready') return { kind: 'ready', row };
  let head;
  try {
    head = await d.files.head(row.key);
  } catch (error) {
    if (error instanceof FileStorageError && error.kind === 'not-found') return discard(d, row, 'upload_missing');
    throw error;
  }
  if (head.size !== row.size) return discard(d, row, 'size_mismatch');
  if (isCheckedType(row.contentType) && (await d.sniff(await firstBytes(d, row.key))) !== row.contentType) return discard(d, row, 'type_mismatch');
  const ready = await d.repo.markReady(row.id, d.now());
  if (ready !== undefined) return { kind: 'ready', row: ready };
  // Not pending any more: another completion won (the same row, ready), or the upload expired and a clean-up has it.
  const now = await d.repo.get(row.id);
  return now?.status === 'ready' ? { kind: 'ready', row: now } : { kind: 'gone' };
}
