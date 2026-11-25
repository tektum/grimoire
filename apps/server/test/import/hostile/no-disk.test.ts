import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultImportConfig } from '@tektum/grimoire-core/testing/fake-config';
import { openArchive } from '../../../src/import/zip-reader.js';
import { SegmentStore } from './segment-store.js';
import { buildSegments } from './zip-builder.js';

// M7-T03: reading an archive writes nothing to disk (R12.30): the zip is read through ranged gets of the store, entries are streams, and no path of an entry is ever opened for writing.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('reading an archive', () => {
  it('makes no write call to the file system, with the temporary directory pointing somewhere that cannot be written', async () => {
    vi.stubEnv('TMPDIR', '/proc/no-such-dir');
    const writers = ['createWriteStream', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdtemp', 'mkdtempSync', 'mkdir', 'mkdirSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'truncate', 'writeSync', 'write'] as const;
    const spies = writers.map((name) => vi.spyOn(fs, name as 'writeFile').mockImplementation((() => { throw new Error(`a write call: ${name}`); }) as never));
    const opens = vi.spyOn(fs, 'open');
    const s = new SegmentStore(buildSegments([{ name: 'a.md', data: Buffer.from('hello') }, { name: 'dir/' }, { name: 'dir/b.md', data: Buffer.from('x'.repeat(500)), method: 'deflate' }, { name: '../evil.txt', data: Buffer.from('x') }]));
    const bad = await openArchive(s, 'imports/x.zip', s.size, defaultImportConfig);
    const good = new SegmentStore(buildSegments([{ name: 'a.md', data: Buffer.from('hello') }, { name: 'dir/b.md', data: Buffer.from('x'.repeat(500)), method: 'deflate' }]));
    const result = await openArchive(good, 'imports/x.zip', good.size, defaultImportConfig);
    if (result.kind !== 'ok') throw new Error('refused');
    for (const entry of result.entries) for await (const chunk of await result.reader.openEntry(entry, defaultImportConfig)) void chunk;
    result.reader.close();
    expect(bad.kind).toBe('refused');
    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
    expect(opens.mock.calls.filter(([, flags]) => typeof flags === 'string' && /[wa+]/.test(flags))).toEqual([]);
  });
});
