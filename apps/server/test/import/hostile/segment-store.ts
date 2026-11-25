import type { ByteStream, FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import type { Segment } from './zip-builder.js';

/** One chunk at most per `yield`: what a store hands back, so that a reader counts bytes as they arrive. */
const CHUNK = 64 * 1024;
const ZEROS = Buffer.alloc(CHUNK);

/** A read-only file store over segments of bytes and runs of zeros (the zeros are not held), recording every ranged `get`. Only `head` and `get` are used by the reader. */
export class SegmentStore implements FileStorage {
  readonly ranges: { start: number; end: number }[] = [];
  readonly size: number;
  constructor(private readonly segments: readonly Segment[], private readonly key = 'imports/x.zip') {
    this.size = segments.reduce((n, s) => n + ('zeros' in s ? s.zeros : s.bytes.length), 0);
  }

  head(key: string): Promise<{ size: number; contentType: string; etag: string; modifiedAt: number }> {
    if (key !== this.key) return Promise.reject(new FileStorageError('not-found', 'missing'));
    return Promise.resolve({ size: this.size, contentType: 'application/zip', etag: 'e', modifiedAt: 0 });
  }

  get(key: string, o: { range?: { start: number; end: number } } = {}): Promise<{ body: ByteStream; size: number; contentType: string }> {
    if (key !== this.key) return Promise.reject(new FileStorageError('not-found', 'missing'));
    const start = o.range?.start ?? 0;
    const end = o.range?.end ?? this.size - 1;
    if (start < 0 || end >= this.size || start > end) return Promise.reject(new FileStorageError('range-not-satisfiable', 'outside the object'));
    this.ranges.push({ start, end });
    const segments = this.segments;
    async function* body(): AsyncGenerator<Uint8Array> {
      let at = 0;
      for (const segment of segments) {
        const length = 'zeros' in segment ? segment.zeros : segment.bytes.length;
        const from = Math.max(start, at);
        const to = Math.min(end + 1, at + length);
        if (from < to) {
          if ('zeros' in segment) for (let n = from; n < to; n += CHUNK) yield ZEROS.subarray(0, Math.min(CHUNK, to - n));
          else for (let n = from; n < to; n += CHUNK) yield segment.bytes.subarray(n - at, Math.min(to, n + CHUNK) - at);
        }
        at += length;
        if (at > end) break;
      }
    }
    return Promise.resolve({ body: body(), size: end - start + 1, contentType: 'application/zip' });
  }

  put(): Promise<{ etag: string }> { return Promise.reject(new Error('read-only')); }
  delete(): Promise<void> { return Promise.reject(new Error('read-only')); }
  list(): Promise<{ items: { key: string; size: number; modifiedAt: number }[]; nextCursor: string | null }> { return Promise.reject(new Error('read-only')); }
  signUpload(): never { throw new Error('read-only'); }
  signDownload(): never { throw new Error('read-only'); }
}
