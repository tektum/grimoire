/**
 * Stored files: the port the attachment code talks to (spec R2.18, R2.35, R2.38).
 * No import and no provider type: adapters convert to and from their own stream types.
 */

export type FileStorageErrorKind =
  'not-found' | 'range-not-satisfiable' | 'unavailable' | 'invalid-key' | 'unsupported' | 'already-exists' | 'invalid-parts';

export class FileStorageError extends Error {
  constructor(
    readonly kind: FileStorageErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'FileStorageError';
  }
}

export type ByteStream = AsyncIterable<Uint8Array>;

export interface FileStorage {
  head(key: string): Promise<{ size: number; contentType: string; etag: string; modifiedAt: number }>;
  /** `range.end` is inclusive. */
  get(
    key: string,
    o?: { range?: { start: number; end: number } },
  ): Promise<{ body: ByteStream; size: number; contentType: string }>;
  /** With `ifNoneMatch` an existing key is refused with `already-exists`. */
  put(
    key: string,
    body: ByteStream | Uint8Array,
    o: { size: number; contentType: string; ifNoneMatch?: boolean },
  ): Promise<{ etag: string }>;
  /** An absent key is a success. */
  delete(key: string): Promise<void>;
  /** Ascending by key; `limit` defaults to and is capped at 1000. */
  list(
    prefix: string,
    o?: { cursor?: string; limit?: number },
  ): Promise<{ items: { key: string; size: number; modifiedAt: number }[]; nextCursor: string | null }>;
  signUpload(
    key: string,
    o: {
      size: number;
      contentType: string;
      ttlSeconds: number;
      disposition?: 'attachment';
      ifNoneMatch?: boolean;
    },
  ): Promise<{ method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: number }>;
  signDownload(
    key: string,
    o: { ttlSeconds: number; disposition: 'inline' | 'attachment'; fileName?: string; contentType?: string },
  ): Promise<{ url: string; expiresAt: number }>;
  /**
   * A multipart upload: one object written in parts that a client sends straight to the store. `createMultipart` opens it (the object does
   * not exist until `completeMultipart`); `signPart` signs one part for exactly `size` bytes, so a client can write no more than it was
   * given; `listParts` is what the store holds (for a client that resumes); `completeMultipart` joins the parts held, numbered 1 to n
   * with no gap, and refuses (`invalid-parts`) an empty list, a gap, or a part but the last under `MIN_PART_BYTES`; `abortMultipart`
   * drops the parts, and an unknown upload is a success. An unknown upload is `not-found` everywhere else. The ETags never leave the adapter.
   */
  createMultipart(key: string, o: { contentType: string }): Promise<{ uploadId: string }>;
  signPart(
    key: string,
    o: { uploadId: string; partNumber: number; size: number; ttlSeconds: number },
  ): Promise<{ method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: number }>;
  listParts(key: string, uploadId: string): Promise<{ partNumber: number; size: number }[]>;
  completeMultipart(key: string, uploadId: string): Promise<{ etag: string; size: number }>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

/** The smallest part but the last, and the most parts, that S3 takes (and so every store we run on). */
export const MIN_PART_BYTES = 5 * 1024 * 1024;
export const MAX_PARTS = 10_000;

export const MAX_KEY_BYTES = 512;
/** The store we ship cannot hold a longer path segment, so the contract refuses one for every adapter. */
export const MAX_SEGMENT_BYTES = 255;
export const LIST_LIMIT_MAX = 1000;

/**
 * A key is 1 to 512 UTF-8 bytes, with no leading or trailing slash, no empty segment, no `.` or `..` segment, no
 * backslash, no control character (C0, DEL and C1) and no lone surrogate. No segment (the text between slashes) is
 * longer than 255 UTF-8 bytes: a long key is made of several segments. Keys the product builds are short.
 */
export function isValidKey(key: string): boolean {
  if (key.length === 0) return false;
  const encoder = new TextEncoder();
  if (encoder.encode(key).length > MAX_KEY_BYTES) return false;
  if (/[\\\p{Cc}\p{Cs}]/u.test(key)) return false;
  return key
    .split('/')
    .every(
      (segment) =>
        segment !== '' && segment !== '.' && segment !== '..' && encoder.encode(segment).length <= MAX_SEGMENT_BYTES,
    );
}

/** Throws `invalid-key` for a key that `isValidKey` refuses. */
export function assertValidKey(key: string): void {
  if (!isValidKey(key)) throw new FileStorageError('invalid-key', 'the storage key is not valid');
}
