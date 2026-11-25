import type { Readable } from 'node:stream';
import { EntryAbort } from './zip-reader.js';
import type { ZipEntry } from './zip-reader.js';

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
