import { PassThrough, Readable } from 'node:stream';
import yauzl from 'yauzl';
import { checkHeader } from '@tektum/grimoire-core/import/checks';
import type { ArchiveEntry, HeaderRefusal } from '@tektum/grimoire-core/import/checks';
import type { ImportConfig } from '@tektum/grimoire-core/ports/config';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';

/** The bytes fetched at once when yauzl asks for a few: headers and the central directory are read in windows of this size, not one request each. */
export const READ_AHEAD_BYTES = 64 * 1024;

/** An entry of the archive: what the central directory says, and nothing read from the entry itself. */
export interface ZipEntry extends ArchiveEntry {
  readonly index: number;
  /** False when the name is not valid UTF-8 (the cp437 names of old archivers, or bytes that are no text): the entry is `bad_name`, and its `path` is what a lenient decoding gives. */
  readonly nameValid: boolean;
  readonly isCompressed: boolean;
  /** Kept to open the entry later. */
  readonly raw: yauzl.Entry;
}

export type EntryAbortReason = 'size_mismatch' | 'entry_too_large' | 'ratio';
/** Why reading an entry stopped. Carries no name and no content. */
export class EntryAbort extends Error {
  constructor(readonly reason: EntryAbortReason) {
    super(`entry read aborted: ${reason}`);
    this.name = 'EntryAbort';
  }
}

export type OpenResult =
  | { readonly kind: 'ok'; readonly reader: ZipReader; readonly entries: readonly ZipEntry[] }
  | { readonly kind: 'refused'; readonly reason: HeaderRefusal | 'not_a_zip'; readonly index?: number };

/** A yauzl random-access reader over ranged `get` calls of the file store: no temporary file, a read-ahead window for the small reads. */
/** Resolves when `out` has drained or closed, and leaves neither listener behind (one per chunk would pile up over a long read). */
function drainedOrClosed(out: Readable): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => { out.off('drain', done); out.off('close', done); resolve(); };
    out.once('drain', done);
    out.once('close', done);
  });
}

class StorageReader extends yauzl.RandomAccessReader {
  calls = 0;
  private window: { start: number; bytes: Buffer } | undefined;
  constructor(private readonly files: FileStorage, private readonly key: string, private readonly size: number) { super(); }

  private async fetch(start: number, endExclusive: number): Promise<AsyncIterable<Uint8Array>> {
    this.calls++;
    return (await this.files.get(this.key, { range: { start, end: endExclusive - 1 } })).body;
  }

  /** yauzl's `end` is exclusive. A small range is served from a 64 KiB window fetched once; a big one is streamed as it arrives. */
  override _readStreamForRange(start: number, end: number): Readable {
    const out = new PassThrough();
    const pump = async (): Promise<void> => {
      if (end - start <= READ_AHEAD_BYTES) {
        const w = this.window;
        if (w === undefined || start < w.start || end > w.start + w.bytes.length) {
          const windowEnd = Math.min(this.size, start + READ_AHEAD_BYTES);
          const chunks: Buffer[] = [];
          for await (const chunk of await this.fetch(start, windowEnd)) chunks.push(Buffer.from(chunk));
          this.window = { start, bytes: Buffer.concat(chunks) };
        }
        const have = this.window;
        if (have === undefined) throw new Error('read-ahead window missing');
        out.end(have.bytes.subarray(start - have.start, end - have.start));
        return;
      }
      for await (const chunk of await this.fetch(start, end)) {
        // A consumer that destroys `out` (yauzl tearing down after an abort, a caller that stops reading) is never going to drain it: stop, and leaving the loop returns the storage body.
        if (out.destroyed) return;
        if (!out.write(chunk)) await drainedOrClosed(out);
      }
      if (!out.destroyed) out.end();
    };
    pump().catch((e: unknown) => { out.destroy(e instanceof Error ? e : new Error('read failed')); });
    return out;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const lenient = new TextDecoder('utf-8');

function describe(raw: yauzl.Entry, index: number): ZipEntry {
  const nameBytes = raw.fileNameRaw;
  let nameValid = true;
  try { utf8.decode(nameBytes); } catch { nameValid = false; }
  const path = lenient.decode(nameBytes);
  const unix = (raw.versionMadeBy >>> 8) === 3;
  const type = unix ? (raw.externalFileAttributes >>> 16) & 0xf000 : 0;
  // A trailing slash is a directory only when the mode (if the archive has one) agrees: `dev/` with the mode of a device is a device, which the header check refuses.
  const named = path.endsWith('/');
  const isDirectory = type === 0x4000 || (named && type === 0);
  return {
    index, path, nameValid, size: raw.uncompressedSize, compressedSize: raw.compressedSize, isCompressed: raw.compressionMethod !== 0, raw,
    isSymlink: type === 0xa000, isDirectory, isRegular: !isDirectory && !named && (type === 0x8000 || type === 0),
  };
}

export class ZipReader {
  constructor(private readonly zip: yauzl.ZipFile, private readonly storage: StorageReader, readonly entryCount: number) {}

  /** The ranged `get` calls made so far. */
  get requests(): number { return this.storage.calls; }

  /** Every entry, in the order of the central directory. */
  entries(): Promise<ZipEntry[]> {
    return new Promise((resolve, reject) => {
      const out: ZipEntry[] = [];
      this.zip.on('entry', (raw: yauzl.Entry) => { out.push(describe(raw, out.length)); this.zip.readEntry(); });
      this.zip.once('end', () => { resolve(out); });
      this.zip.once('error', reject);
      this.zip.readEntry();
    });
  }

  /**
   * The content of one entry, counting the bytes that really come out and never trusting the header: it aborts with `size_mismatch` the moment more than the declared size
   * has come (so a lie of 50 MB is caught after the declared bytes plus one chunk), or when fewer come; with `entry_too_large` above the cap; with `ratio` above the per-entry
   * ratio of the compressed size. The path of an entry is never used to write anything.
   */
  openEntry(entry: ZipEntry, limits: Pick<ImportConfig, 'maxEntryBytes' | 'maxRatio'>): Promise<Readable> {
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(entry.raw, { validateEntrySizes: false } as yauzl.ZipFileOptions, (err, stream) => {
        if (err) { reject(err); return; }
        let seen = 0;
        const out = new PassThrough();
        const abort = (reason: EntryAbortReason): void => { stream.destroy(); out.destroy(new EntryAbort(reason)); };
        // A consumer that stops reading (a `break`, its own limit) destroys `out`: the source stream goes with it, or it would wait for a drain that never comes.
        out.once('close', () => { stream.destroy(); });
        stream.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > entry.size) { abort('size_mismatch'); return; }
          if (seen > limits.maxEntryBytes) { abort('entry_too_large'); return; }
          if (seen > limits.maxRatio * Math.max(entry.compressedSize, 1)) { abort('ratio'); return; }
          if (!out.write(chunk)) { stream.pause(); out.once('drain', () => { stream.resume(); }); }
        });
        stream.once('end', () => { if (seen !== entry.size) out.destroy(new EntryAbort('size_mismatch')); else out.end(); });
        stream.once('error', (e: Error) => { out.destroy(e); });
        resolve(out);
      });
    });
  }

  close(): void { this.zip.close(); }
}

/** The first four bytes of a zip: a local file header, or an end of directory record for an empty archive. */
export const ZIP_MAGIC = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])];

/**
 * Stage 2 (contracts section 4): the first four bytes are `PK\x03\x04` (or `PK\x05\x06` for an empty archive), then the central directory is read through ranged `get` calls, the
 * entry count is judged before any entry is read, and the header check of the core runs over the metadata. Nothing of an entry's content has been read when this returns.
 */
export async function openArchive(files: FileStorage, key: string, size: number, limits: Pick<ImportConfig, 'maxEntries' | 'maxUncompressedBytes' | 'maxRatio'>): Promise<OpenResult> {
  if (size < 22) return { kind: 'refused', reason: 'not_a_zip' }; // the end-of-directory record alone is 22 bytes
  const head = Buffer.concat(await collect((await files.get(key, { range: { start: 0, end: 3 } })).body));
  if (!ZIP_MAGIC.some((m) => head.equals(m))) return { kind: 'refused', reason: 'not_a_zip' };
  const storage = new StorageReader(files, key, size);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromRandomAccessReader(storage, size, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: false, strictFileNames: false }, (err, z) => { if (err) reject(err); else resolve(z); });
  }).catch(() => undefined);
  if (zip === undefined) return { kind: 'refused', reason: 'not_a_zip' };
  const reader = new ZipReader(zip, storage, zip.entryCount);
  if (zip.entryCount > limits.maxEntries) { reader.close(); return { kind: 'refused', reason: 'too_many_entries' }; }
  const entries = await reader.entries().catch(() => undefined);
  if (entries === undefined) { reader.close(); return { kind: 'refused', reason: 'not_a_zip' }; }
  const checked = checkHeader(entries, size, limits);
  if (!checked.ok) { reader.close(); return { kind: 'refused', reason: checked.reason, ...(checked.index === undefined ? {} : { index: checked.index }) }; }
  return { kind: 'ok', reader, entries };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of body) out.push(Buffer.from(chunk));
  return out;
}
