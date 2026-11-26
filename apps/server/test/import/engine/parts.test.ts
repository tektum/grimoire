import { describe, expect, it, vi } from 'vitest';
import { defaultImportConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { openParts, ZipReader } from '../../../src/import/zip-reader.js';
import { buildZip } from '../hostile/zip-builder.js';
import type { BuilderEntry } from '../hostile/zip-builder.js';

// The zips of an export in parts, read as one archive by the import job.
const file = (name: string, body = ''): BuilderEntry => ({ name, data: Buffer.from(body) });
async function store(...zips: BuilderEntry[][]) {
  const files = new FakeFileStorage();
  const parts: { key: string; size: number }[] = [];
  for (const [i, entries] of zips.entries()) {
    const zip = buildZip(entries);
    await files.put(`imports/p${String(i)}.zip`, zip, { size: zip.length, contentType: 'application/zip' });
    parts.push({ key: `imports/p${String(i)}.zip`, size: zip.length });
  }
  return { files, parts };
}
const text = async (stream: AsyncIterable<Buffer>) => { let out = ''; for await (const chunk of stream) out += chunk.toString(); return out; };

describe('openParts', () => {
  it('numbers the entries across the zips in part order, keeps a folder named in both once, and opens each entry from its own zip', async () => {
    const { files, parts } = await store([{ name: 'd/' }, file('a.md', 'first')], [{ name: 'D/' }, file('d/b.md', 'second')]);
    const opened = await openParts(files, parts, defaultImportConfig);
    if (opened.kind !== 'ok') throw new Error(opened.reason);
    expect(opened.entries.map((e) => [e.index, e.path])).toEqual([[0, 'd/'], [1, 'a.md'], [2, 'd/b.md']]);
    const b = opened.entries[2];
    if (b === undefined) throw new Error('no entry');
    expect(await text(await opened.reader.openEntry(b, defaultImportConfig))).toBe('second');
    await expect(opened.reader.openEntry({ ...b }, defaultImportConfig), 'an entry that is not one of these zips').rejects.toThrow();
    opened.reader.close();
  });

  it('refuses no zip at all, and a part that is not a zip with the reason of that part', async () => {
    const files = new FakeFileStorage();
    expect(await openParts(files, [], defaultImportConfig)).toEqual({ kind: 'refused', reason: 'not_a_zip' });
    const { files: two, parts } = await store([file('a.md')], [file('b.md')]);
    await two.put('imports/bad.zip', Buffer.alloc(40, 1), { size: 40, contentType: 'application/zip' });
    expect(await openParts(two, [...parts, { key: 'imports/bad.zip', size: 40 }], defaultImportConfig)).toEqual({ kind: 'refused', reason: 'not_a_zip' });
  });
  it('closes the readers of the zips already opened when a later one cannot be opened at all (the store answers with an error), and rethrows', async () => {
    const { files, parts } = await store([file('a.md')], [file('b.md')]);
    const close = vi.spyOn(ZipReader.prototype, 'close');
    try {
      await expect(openParts(files, [...parts, { key: 'imports/not-there.zip', size: 500 }], defaultImportConfig)).rejects.toThrow();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
    }
  });
});
