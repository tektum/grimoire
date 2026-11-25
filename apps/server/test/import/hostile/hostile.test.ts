import { describe, expect, it, vi } from 'vitest';
import { defaultImportConfig } from '@tektum/grimoire-core/testing/fake-config';
import { duplicateIndexes } from '@tektum/grimoire-core/import/checks';
import { EntryAbort, openArchive } from '../../../src/import/zip-reader.js';
import type { ZipReader } from '../../../src/import/zip-reader.js';
import { SegmentStore } from './segment-store.js';
import { buildSegments, buildZip, deflateZeros } from './zip-builder.js';
import type { BuilderEntry } from './zip-builder.js';

// M7-T03 (contracts section 7): the hostile corpus, one archive each, built in memory (nothing is written to disk) and read through a store that records every ranged get.
const limits = defaultImportConfig;
const MiB = 1024 * 1024;
const store = (entries: readonly BuilderEntry[], options: { zip64?: boolean } = {}) => new SegmentStore(buildSegments(entries, options));
const open = (s: SegmentStore, over: Partial<typeof limits> = {}) => openArchive(s, 'imports/x.zip', s.size, { ...limits, ...over });
async function read(reader: ZipReader, entry: Parameters<ZipReader['openEntry']>[0], over: Partial<typeof limits> = {}): Promise<{ bytes: number } | { aborted: string; bytes: number }> {
  let bytes = 0;
  try {
    for await (const chunk of await reader.openEntry(entry, { ...limits, ...over })) bytes += (chunk as Buffer).length;
    return { bytes };
  } catch (e) {
    if (e instanceof EntryAbort) return { aborted: e.reason, bytes };
    throw e;
  }
}
const ok = async (s: SegmentStore, over: Partial<typeof limits> = {}) => { const r = await open(s, over); if (r.kind !== 'ok') throw new Error(`refused: ${r.reason}`); return r; };

describe('a plain archive', () => {
  it('lists its entries and gives the content of each, stored or deflated', async () => {
    const s = store([{ name: 'a.md', data: Buffer.from('hello') }, { name: 'dir/' }, { name: 'dir/b.md', data: Buffer.from('x'.repeat(1000)), method: 'deflate' }]);
    const { reader, entries } = await ok(s);
    expect(entries.map((e) => [e.path, e.isDirectory, e.size])).toEqual([['a.md', false, 5], ['dir/', true, 0], ['dir/b.md', false, 1000]]);
    const chunks: Buffer[] = [];
    for await (const c of await reader.openEntry(entries[2]!, limits)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('x'.repeat(1000));
    expect(await read(reader, entries[0]!)).toEqual({ bytes: 5 });
  });

  it('is read in windows, not one request per header', async () => {
    const s = store(Array.from({ length: 200 }, (_, i) => ({ name: `f${String(i)}.md`, data: Buffer.from('x') })));
    await ok(s);
    expect(s.ranges.length).toBeLessThan(10);
  });
});

describe('an empty archive', () => {
  it('is an archive with no entries, not a refusal', async () => {
    const s = new SegmentStore([{ bytes: buildZip([]) }]);
    expect(s.size).toBe(22);
    const r = await open(s);
    expect(r.kind === 'ok' ? r.entries : 'refused').toEqual([]);
  });
});

describe('not an archive', () => {
  it.each([['empty', Buffer.alloc(0)], ['text', Buffer.from('just some text, long enough to be more than twenty-two bytes')], ['a PK that is not a header', Buffer.from('PK\x01\x02 and then more bytes until it is long enough')]])('%s is refused as not_a_zip', async (_n, bytes) => {
    const s = new SegmentStore([{ bytes }]);
    expect(await open(s)).toEqual({ kind: 'refused', reason: 'not_a_zip' });
  });

  it('a truncated archive is refused, not thrown', async () => {
    const whole = buildZip([{ name: 'a.md', data: Buffer.from('hello') }]);
    const s = new SegmentStore([{ bytes: whole.subarray(0, whole.length - 10) }]);
    expect((await open(s)).kind).toBe('refused');
  });
});

describe.each([
  ['traversal', [{ name: 'ok.md', data: Buffer.from('1') }, { name: '../evil.txt', data: Buffer.from('x') }], 'unsafe_path', 1],
  ['nested traversal', [{ name: 'a/../../b.txt', data: Buffer.from('x') }], 'unsafe_path', 0],
  ['absolute', [{ name: '/abs/evil.txt', data: Buffer.from('x') }], 'unsafe_path', 0],
  ['drive letter', [{ name: 'c:\\win\\x.txt', data: Buffer.from('x') }], 'unsafe_path', 0],
  ['backslash', [{ name: 'a\\b.txt', data: Buffer.from('x') }], 'unsafe_path', 0],
  ['symlink', [{ name: 'l', data: Buffer.from('/etc/passwd'), mode: 0o120777 }], 'symlink', 0],
  ['device', [{ name: 'dev', data: Buffer.alloc(0), mode: 0o020666 }], 'non_regular', 0],
  ['device named as a directory', [{ name: 'dev/', data: Buffer.alloc(0), mode: 0o020666 }], 'non_regular', 0],
  ['fifo named as a directory', [{ name: 'a/fifo/', data: Buffer.alloc(0), mode: 0o010644 }], 'non_regular', 0],
  ['socket named as a directory', [{ name: 'sock/', data: Buffer.alloc(0), mode: 0o140755 }], 'non_regular', 0],
  ['regular file named as a directory', [{ name: 'file/', data: Buffer.from('x'), mode: 0o100644 }], 'non_regular', 0],
] as const)('the %s archive', (_n, entries, reason, index) => {
  it(`fails the whole import with ${reason}, naming the entry's index, before any entry is read`, async () => {
    const big = [...entries, { name: 'pad.bin', data: Buffer.alloc(2 * MiB, 1) }] as BuilderEntry[];
    const s = store(big);
    expect(await open(s)).toEqual({ kind: 'refused', reason, index });
    expect(s.ranges.reduce((n, r) => n + r.end - r.start + 1, 0)).toBeLessThan(200 * 1024); // the 2 MiB of content was never fetched
  });
});

describe('the bomb', () => {
  it('2 GiB of zeros in a few megabytes is refused by the header, without reading an entry', async () => {
    const body = deflateZeros(2 * 1024 * MiB);
    expect(body.length).toBeLessThan(20 * MiB);
    const s = store([{ name: 'zeros.bin', precompressed: body, declaredSize: 2 * 1024 * MiB }]);
    const t = Date.now();
    expect(await open(s)).toEqual({ kind: 'refused', reason: 'ratio' });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(s.ranges.reduce((n, r) => n + r.end - r.start + 1, 0)).toBeLessThan(64 * MiB);
  });

  it('one that passes the ratio is stopped at the entry cap, having read only the compressed bytes of it', async () => {
    const size = 150 * MiB;
    const body = deflateZeros(size);
    const s = store([{ name: 'zeros.bin', precompressed: body, declaredSize: size }]);
    const { reader, entries } = await ok(s, { maxRatio: 1000 });
    const t = Date.now();
    const result = await read(reader, entries[0]!, { maxRatio: 1000 });
    expect(result).toMatchObject({ aborted: 'entry_too_large' });
    expect(result.bytes).toBeLessThanOrEqual(limits.maxEntryBytes);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('a consumer that walks away from an entry', () => {
  it('breaking out of the entry stream releases the storage body, and the read stops (a big range, more than the read-ahead window)', async () => {
    const s = store([{ name: 'big.bin', data: Buffer.alloc(6 * MiB, 7) }]);
    const { reader, entries } = await ok(s);
    for await (const chunk of await reader.openEntry(entries[0]!, limits)) { expect((chunk as Buffer).length).toBeGreaterThan(0); break; }
    await vi.waitFor(() => { expect(s.openBodies).toBe(0); }, { timeout: 3000 });
    const gets = s.ranges.length;
    await new Promise<void>((resolve) => { setTimeout(resolve, 200); }); // a read that went on would fetch more
    expect(s.ranges.length).toBe(gets);
  });

  it('a directory entry is still a directory: a trailing slash with no mode, or the directory mode, is not refused', async () => {
    const s = store([{ name: 'dir/', mode: 0o040755 }, { name: 'other/', mode: 0 }, { name: 'dir/a.md', data: Buffer.from('x') }]);
    expect(await open(s)).toMatchObject({ kind: 'ok' });
  });
});

describe('a long read', () => {
  it('leaves no listener behind on the stream it feeds: reading a 6 MiB entry (many drains) raises no max-listeners warning', async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error): void => { warnings.push(w.name); };
    process.on('warning', onWarning);
    try {
      const s = store([{ name: 'big.bin', data: Buffer.alloc(6 * MiB, 7) }]);
      const { reader, entries } = await ok(s);
      expect(await read(reader, entries[0]!)).toEqual({ bytes: 6 * MiB });
      await new Promise<void>((resolve) => { setImmediate(resolve); }); // warnings are emitted on the next tick
      expect(warnings).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
  });
});

describe('a consumer that is late', () => {
  it('an entry that is aborted before anyone reads it fails the read that comes later, and is not an uncaught error', async () => {
    const s = store([{ name: 'lie.md', data: Buffer.alloc(500, 0x61), declaredSize: 10 }]);
    const { reader, entries } = await ok(s);
    const stream = await reader.openEntry(entries[0]!, limits);
    await vi.waitFor(() => { expect(stream.destroyed).toBe(true); }, { timeout: 5000, interval: 5 }); // the abort has happened, with nobody listening
    const read = async (): Promise<void> => { for await (const chunk of stream) void chunk; };
    await expect(read()).rejects.toMatchObject({ reason: 'size_mismatch' });
  });
});

describe('the lying archive', () => {
  it('an entry that declares 100 bytes and holds 5 MB is aborted as size_mismatch after the declared bytes plus one chunk', async () => {
    const s = store([{ name: 'lies.bin', data: Buffer.alloc(5 * MiB, 7), method: 'deflate', declaredSize: 100 }]);
    const { reader, entries } = await ok(s);
    const result = await read(reader, entries[0]!);
    expect(result).toMatchObject({ aborted: 'size_mismatch' });
    expect(result.bytes).toBeLessThanOrEqual(100 + 64 * 1024);
  });

  it('an entry that holds fewer bytes than it declares is size_mismatch at its end', async () => {
    const s = store([{ name: 'short.bin', data: Buffer.alloc(50, 1), method: 'deflate', declaredSize: 100 }]);
    const { reader, entries } = await ok(s);
    expect(await read(reader, entries[0]!)).toMatchObject({ aborted: 'size_mismatch' });
  });
});

describe('many entries', () => {
  it('100,000 entries (zip64) are refused by the count in under 5 s, without listing them', async () => {
    const entries = Array.from({ length: 100_000 }, (_, i) => ({ name: `f${String(i)}.md`, data: Buffer.alloc(0) }));
    const s = store(entries, { zip64: true });
    const before = process.memoryUsage().rss;
    const t = Date.now();
    expect(await open(s)).toEqual({ kind: 'refused', reason: 'too_many_entries' });
    expect(Date.now() - t).toBeLessThan(5000);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * MiB);
  });
});

describe('names', () => {
  it('cp437 and invalid UTF-8 names are listed as not valid, and nothing throws', async () => {
    const s = store([{ name: Buffer.from([0x82, 0x63, 0x6f, 0x6c, 0x65, 0x2e, 0x6d, 0x64]), data: Buffer.from('1') }, { name: Buffer.from([0xff, 0xfe, 0x2e, 0x6d, 0x64]), data: Buffer.from('2') }, { name: 'fine.md', data: Buffer.from('3') }]);
    const { entries } = await ok(s);
    expect(entries.map((e) => e.nameValid)).toEqual([false, false, true]);
  });

  it('two names that differ only by case or by normalisation are duplicates, the later one', async () => {
    const s = store([{ name: 'A.md', data: Buffer.from('1') }, { name: 'a.md', data: Buffer.from('2') }]);
    const { entries } = await ok(s);
    expect([...duplicateIndexes(entries.map((e) => e.path))]).toEqual([1]);
  });
});

describe('a big entry among others', () => {
  it('101 MiB is entry_too_large and the other entries are read', async () => {
    const size = 101 * MiB;
    const s = store([{ name: 'a.md', data: Buffer.from('first') }, { name: 'big.bin', precompressed: deflateZeros(size), declaredSize: size }, { name: 'c.md', data: Buffer.from('last') }]);
    const { reader, entries } = await ok(s, { maxRatio: 1000 });
    expect(await read(reader, entries[0]!, { maxRatio: 1000 })).toEqual({ bytes: 5 });
    expect(await read(reader, entries[1]!, { maxRatio: 1000 })).toMatchObject({ aborted: 'entry_too_large' });
    expect(await read(reader, entries[2]!, { maxRatio: 1000 })).toEqual({ bytes: 4 });
  });
});

describe('a large archive', () => {
  it('200 MB is read through fewer than 100 ranged gets and little memory, because only the headers and the one entry asked for are fetched', async () => {
    const s = new SegmentStore(buildSegments([{ name: 'big.bin', gap: 200 * MiB }, { name: 'small.md', data: Buffer.from('tiny') }]));
    const before = process.memoryUsage().rss;
    const { reader, entries } = await ok(s, { maxEntryBytes: 300 * MiB, maxUncompressedBytes: 4 * 1024 * MiB });
    expect(await read(reader, entries[1]!)).toEqual({ bytes: 4 });
    expect(s.ranges.length).toBeLessThan(100);
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * MiB);
    expect(s.size).toBeGreaterThan(200 * MiB);
  });
});
