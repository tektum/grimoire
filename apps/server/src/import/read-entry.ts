import type { Readable } from 'node:stream';
import { EntryAbort } from './zip-reader.js';
import type { EntryAbortReason, ZipEntry } from './zip-reader.js';

export type EntryRead =
  | { readonly kind: 'ok'; readonly bytes: Buffer }
  /** More than the cap: not read on (an entry that declares more is not even opened). */
  | { readonly kind: 'too_large' }
  | { readonly kind: 'failed'; readonly reason: 'size_mismatch' | 'ratio' };

/** What reads an entry's content: `ZipReader.openEntry`. */
export interface EntryOpener { openEntry(entry: ZipEntry, limits: { readonly maxEntryBytes: number; readonly maxRatio: number }): Promise<Readable> }

/**
 * The bytes of an entry counted as they come, at most `cap` of them: more is `too_large` (the stream is destroyed, the entry is not read on), and a header that lies is `size_mismatch`
 * (the reader's own abort). The declared size is a hint only: an entry that declares more than `cap` is refused without being opened.
 */
export async function readEntry(reader: EntryOpener, limits: { readonly maxEntryBytes: number; readonly maxRatio: number }, entry: ZipEntry, cap: number): Promise<EntryRead> {
  if (entry.size > cap) return { kind: 'too_large' };
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const stream = await reader.openEntry(entry, limits);
    for await (const chunk of stream) {
      total += (chunk as Buffer).length;
      if (total > cap) { stream.destroy(); return { kind: 'too_large' }; }
      chunks.push(chunk as Buffer);
    }
  } catch (e) {
    if (!(e instanceof EntryAbort)) throw e;
    return e.reason === 'entry_too_large' ? { kind: 'too_large' } : { kind: 'failed', reason: e.reason };
  }
  return { kind: 'ok', bytes: Buffer.concat(chunks) };
}

export type EntryStream =
  | {
      readonly kind: 'ok';
      /** The first bytes of the entry (up to the number asked for, fewer when the entry is shorter), for a check made before anything is sent on. */
      readonly head: Buffer;
      /** The whole entry from its first byte, read as it is taken: nothing of it is held. */
      readonly body: AsyncIterable<Buffer>;
      /** Why the reader stopped the entry (a header that lies, a cap), once `body` has failed; undefined when it did not. */
      readonly aborted: () => EntryAbortReason | undefined;
      /** Ends the read: for a caller that does not take the whole body. */
      readonly close: () => void;
    }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'failed'; readonly reason: 'size_mismatch' | 'ratio' };

/**
 * An entry as a stream, for one too large to hold in memory (a video): the first `peek` bytes are read now, so that the caller can judge the entry before it sends any of it, and
 * `body` then gives the whole entry. The reader counts the bytes as they come and fails the stream when the entry lies about its size or goes over the cap, so a caller that sends
 * `body` to the store learns of it as the send failing, and asks `aborted()` why. An entry that declares more than the cap is not even opened.
 */
export async function streamEntry(reader: EntryOpener, limits: { readonly maxEntryBytes: number; readonly maxRatio: number }, entry: ZipEntry, peek: number): Promise<EntryStream> {
  if (entry.size > limits.maxEntryBytes) return { kind: 'too_large' };
  let why: EntryAbortReason | undefined;
  const stopped = (e: unknown): EntryStream => {
    if (!(e instanceof EntryAbort)) throw e;
    why = e.reason;
    return e.reason === 'entry_too_large' ? { kind: 'too_large' } : { kind: 'failed', reason: e.reason };
  };
  const stream = await reader.openEntry(entry, limits);
  const chunks = stream[Symbol.asyncIterator]();
  const first: Buffer[] = [];
  let have = 0;
  try {
    while (have < peek) {
      const next = await chunks.next();
      if (next.done === true) break;
      first.push(next.value as Buffer);
      have += (next.value as Buffer).length;
    }
  } catch (e) {
    stream.destroy();
    return stopped(e);
  }
  async function* body(): AsyncGenerator<Buffer> {
    try {
      yield* first;
      for (let next = await chunks.next(); next.done !== true; next = await chunks.next()) yield next.value as Buffer;
    } catch (e) {
      if (e instanceof EntryAbort) why = e.reason;
      throw e;
    } finally {
      stream.destroy();
    }
  }
  return { kind: 'ok', head: Buffer.concat(first), body: body(), aborted: () => why, close: () => { stream.destroy(); } };
}
