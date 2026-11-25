import { crc32, deflateRawSync } from 'node:zlib';

// A hand-written zip writer for tests (M7-T03, contracts section 7): only a hand-written writer can forge headers. It writes what a real archiver would not: a name with `..`, a symlink
// entry, a size that is not the real one, names that are not UTF-8, more entries than the classic format counts (zip64 end records).

export interface BuilderEntry {
  /** The name as bytes written; a string is written as UTF-8 with the UTF-8 flag, a Buffer as given with the flag off. */
  readonly name: string | Buffer;
  /** The real content. Absent for a directory (a name ending in `/`). */
  readonly data?: Buffer;
  readonly method?: 'stored' | 'deflate';
  /** Written in the headers instead of the real sizes: how a lying archive is made. */
  readonly declaredSize?: number;
  readonly declaredCompressedSize?: number;
  /** A body that is already compressed (a raw deflate stream), written as it is with the deflate method; `declaredSize` is then what it inflates to. */
  readonly precompressed?: Buffer;
  /** A stored entry of this many zero bytes that is not held in memory: only `buildSegments` can write it (see `Segment`). */
  readonly gap?: number;
  /** The unix file type and permissions in the high half of the external attributes (default a regular file, 0o100644). */
  readonly mode?: number;
}

const le16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const le32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const le64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** A piece of an archive: bytes, or a run of zeros that is only counted. */
export type Segment = { readonly bytes: Buffer } | { readonly zeros: number };
interface Written { readonly head: Buffer; readonly body: Segment; readonly length: number; readonly central: (offset: number) => Buffer }

function write(entry: BuilderEntry): Written {
  const name = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf8') : entry.name;
  const flags = typeof entry.name === 'string' ? 0x800 : 0;
  const data = entry.data ?? Buffer.alloc(0);
  const stored = (entry.method ?? 'stored') === 'stored';
  const gap = entry.gap;
  const body = entry.precompressed ?? (stored ? data : deflateRawSync(data));
  const size = entry.declaredSize ?? gap ?? (entry.precompressed === undefined ? data.length : 0);
  const compressed = entry.declaredCompressedSize ?? gap ?? body.length;
  const crc = entry.precompressed === undefined && gap === undefined ? crc32(data) : 0;
  const method = stored && entry.precompressed === undefined ? 0 : 8 * Number(entry.precompressed !== undefined || !stored);
  const mode = entry.mode ?? (entry.name.toString().endsWith('/') ? 0o040755 : 0o100644);
  const head = Buffer.concat([le32(0x04034b50), le16(20), le16(flags), le16(method), le16(0), le16(0x21), le32(crc), le32(compressed), le32(size), le16(name.length), le16(0), name]);
  const segment: Segment = gap === undefined ? { bytes: body } : { zeros: gap };
  const central = (offset: number): Buffer => Buffer.concat([
    le32(0x02014b50), le16((3 << 8) | 20), le16(20), le16(flags), le16(method), le16(0), le16(0x21), le32(crc), le32(compressed), le32(size),
    le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(((mode << 16) >>> 0)), le32(offset), name,
  ]);
  return { head, body: segment, length: head.length + (gap ?? body.length), central };
}

/** The segments of an archive of these entries. `zip64` writes the zip64 end records (needed for more than 65,535 entries; harmless below). */
export function buildSegments(entries: readonly BuilderEntry[], options: { zip64?: boolean } = {}): Segment[] {
  const parts: Segment[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const w = write(entry);
    parts.push({ bytes: w.head }, w.body);
    centrals.push(w.central(offset));
    offset += w.length;
  }
  const cd = Buffer.concat(centrals);
  const zip64 = options.zip64 === true || entries.length > 0xffff;
  const tail: Buffer[] = [];
  if (zip64) {
    const recordOffset = offset + cd.length;
    tail.push(Buffer.concat([le32(0x06064b50), le64(44), le16(45), le16(45), le32(0), le32(0), le64(entries.length), le64(entries.length), le64(cd.length), le64(offset)]));
    tail.push(Buffer.concat([le32(0x07064b50), le32(0), le64(recordOffset), le32(1)]));
    tail.push(Buffer.concat([le32(0x06054b50), le16(0xffff), le16(0xffff), le16(0xffff), le16(0xffff), le32(0xffffffff), le32(0xffffffff), le16(0)]));
  } else {
    tail.push(Buffer.concat([le32(0x06054b50), le16(0), le16(0), le16(entries.length), le16(entries.length), le32(cd.length), le32(offset), le16(0)]));
  }
  return [...parts, { bytes: cd }, ...tail.map((bytes) => ({ bytes }))];
}

/** The bytes of an archive that has no run of zeros. */
export function buildZip(entries: readonly BuilderEntry[], options: { zip64?: boolean } = {}): Buffer {
  return Buffer.concat(buildSegments(entries, options).map((s) => {
    if ('zeros' in s) throw new Error('buildZip cannot hold a gap: use buildSegments and a SegmentStore');
    return s.bytes;
  }));
}

/**
 * A raw deflate stream of `bytes` zeros in about `bytes / 159` bytes, written by hand (one fixed-Huffman block: a literal 0, then matches of length 258 at distance 1).
 * It is what makes a bomb of 2 GiB cost a few megabytes of memory.
 */
export function deflateZeros(bytes: number): Buffer {
  let out: number[] = [];
  let acc = 0;
  let nbits = 0;
  const bits = (value: number, count: number, msbFirst = false): void => {
    for (let i = 0; i < count; i++) {
      const bit = msbFirst ? (value >>> (count - 1 - i)) & 1 : (value >>> i) & 1;
      acc |= bit << nbits;
      nbits++;
      if (nbits === 8) { out.push(acc); acc = 0; nbits = 0; }
    }
  };
  const match = (): void => { bits(0b11000101, 8, true); bits(0, 5, true); }; // length 258 (symbol 285), distance 1 (code 0)
  bits(1, 1); bits(1, 2); // final block, fixed Huffman
  bits(0x30, 8, true); // literal 0 (code 00110000)
  let left = bytes - 1;
  // A match is 13 bits, so 8 of them are 13 whole bytes and leave the bit writer in the state it began in: every group of 8 is the same 13 bytes.
  // One group is written bit by bit to get the unit and the rest is a fill, so a 2 GiB bomb costs milliseconds, not millions of bit writes.
  const group = 258 * 8;
  let head = Buffer.alloc(0);
  let repeated = Buffer.alloc(0);
  if (left >= 2 * group) {
    const before = out.length;
    for (let i = 0; i < 8; i++) match();
    left -= group;
    const unit = Buffer.from(out.slice(before));
    const groups = Math.floor(left / group);
    left -= groups * group;
    head = Buffer.from(out);
    repeated = Buffer.alloc(unit.length * groups);
    repeated.fill(unit);
    out = [];
  }
  while (left >= 258) { match(); left -= 258; }
  while (left > 0) { bits(0x30, 8, true); left--; } // the rest as literals
  bits(0, 7, true); // end of block (symbol 256)
  if (nbits > 0) out.push(acc);
  return Buffer.concat([head, repeated, Buffer.from(out)]);
}
