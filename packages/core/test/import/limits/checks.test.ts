import { describe, expect, it } from 'vitest';
import { checkHeader, duplicateIndexes, isBadName, MAX_ENTRY_PATH_BYTES, MAX_REPORTED_NAME_LENGTH, reportedName } from '../../../src/import/checks.js';
import type { ArchiveEntry } from '../../../src/import/checks.js';
import { resolveLinkPath } from '../../../src/import/paths.js';
import { isIgnoredEntry, ITEM_FATE } from '../../../src/import/types.js';
import { defaultImportConfig } from '../../../src/testing/fake-config.js';

// M7-T03 (contracts section 4, stage 2, and section 7): the pure checks over the entry metadata of an archive, before anything is read. They name a reason, never an entry's name.
const limits = defaultImportConfig;
const file = (path: string, over: Partial<ArchiveEntry> = {}): ArchiveEntry => ({ path, size: 10, compressedSize: 10, isSymlink: false, isDirectory: false, isRegular: true, ...over });
const check = (entries: readonly ArchiveEntry[], archiveBytes = 1000) => checkHeader(entries, archiveBytes, limits);

describe('an entry name that could write outside the import', () => {
  it.each([['../a'], ['a/../../b'], ['a/..'], ['/abs'], ['c:\\x'], ['C:/x'], ['a\\b'], ['a\0b'], ['\0']])('%j is refused as unsafe_path, naming the entry index', (name) => {
    expect(check([file('ok.md'), file(name)])).toEqual({ ok: false, reason: 'unsafe_path', index: 1 });
  });

  it('accepts names that only look like it: dots inside a name, a leading dot, a colon later in the name', () => {
    expect(check([file('a..b/c.md'), file('.hidden/x.md'), file('a/b:c.md'), file('...'), file('..a/b')])).toEqual({ ok: true });
  });
});

describe('a name that cannot be kept and shown as it is is one failed item (bad_name), not a refused archive', () => {
  it.each([['a\nb.md'], ['a\tb.md'], ['a\u001bb.md'], ['a\u007fb.md'], ['a\u0085b.md'], ['a\u2028b.md'], ['a\u2029b.md'], ['dir/\u009fx.md']])('%j (a control or line separator character): the archive passes, the name is bad', (name) => {
    expect(check([file('ok.md'), file(name)])).toEqual({ ok: true });
    expect(isBadName(name)).toBe(true);
  });

  it('a name over MAX_ENTRY_PATH_BYTES bytes of UTF-8 is bad, one of exactly that many is not, and neither refuses the archive (the unique index on the path holds about 2.7 KB)', () => {
    const exact = `${'a'.repeat(MAX_ENTRY_PATH_BYTES - 3)}.md`;
    const over = `${'a'.repeat(MAX_ENTRY_PATH_BYTES - 2)}.md`;
    expect([isBadName(exact), isBadName(over)]).toEqual([false, true]);
    expect(check([file('ok.md'), file(over)])).toEqual({ ok: true });
  });

  it('the limit counts bytes, not characters: three-byte characters reach it at a third of the length, and four-byte ones (a surrogate pair) at a quarter', () => {
    const three = '\u65e5'; // 3 bytes
    const four = '\u{1f600}'; // 4 bytes, 2 UTF-16 units
    const fits3 = `${three.repeat(Math.floor((MAX_ENTRY_PATH_BYTES - 3) / 3))}.md`;
    expect([isBadName(fits3), isBadName(`${fits3}${three}`)]).toEqual([false, true]);
    const fits4 = `${four.repeat(Math.floor((MAX_ENTRY_PATH_BYTES - 3) / 4))}.md`;
    expect([isBadName(fits4), isBadName(`${fits4}${four}`)]).toEqual([false, true]);
  });

  it('a name from a page-tree export (a 32-character id in every segment, nested deeply) and ordinary non-ASCII names are fine', () => {
    const segment = `Some page title ${'0123456789abcdef'.repeat(2)}`;
    expect([`${Array.from({ length: 32 }, () => segment).join('/')}.md`, 'caf\u00e9/\u65e5\u672c\u8a9e a.md', 'a b/c d.md'].map(isBadName)).toEqual([false, false, false]);
  });

  it('what is kept of a bad name, to report it, has no control character and is at most 300 characters', () => {
    expect(reportedName('a\u001b[31m\nb.md')).toBe('a[31mb.md');
    expect(reportedName(`${'x'.repeat(400)}\u0007`)).toBe('x'.repeat(300));
    expect(reportedName('plain/name.md')).toBe('plain/name.md');
  });

  it('a reported name is never cut in the middle of a surrogate pair, whatever is removed before the cut', () => {
    const emoji = '\u{1f600}';
    const cut = reportedName(`${'a'.repeat(MAX_REPORTED_NAME_LENGTH - 1)}\n${emoji}`);
    expect(cut).toBe('a'.repeat(MAX_REPORTED_NAME_LENGTH - 1));
    expect(cut.isWellFormed()).toBe(true);
    const whole = reportedName(`${'a'.repeat(MAX_REPORTED_NAME_LENGTH - 2)}${emoji}`);
    expect(whole).toBe(`${'a'.repeat(MAX_REPORTED_NAME_LENGTH - 2)}${emoji}`);
    expect(reportedName(`${'\u{1f600}'.repeat(200)}`).isWellFormed()).toBe(true);
  });

  it('a NUL, a backslash, a drive, an absolute path or a .. segment are still attacks and still refuse the archive', () => {
    for (const name of ['a\0b', '\0', 'a\\b', 'C:/x', '/abs', 'a/../b']) expect(check([file('ok.md'), file(name)])).toEqual({ ok: false, reason: 'unsafe_path', index: 1 });
  });
});

describe('entries that are not files', () => {
  it('refuses a symlink and any other non-regular entry, by their own reasons', () => {
    expect(check([file('l', { isSymlink: true, isRegular: false })])).toEqual({ ok: false, reason: 'symlink', index: 0 });
    expect(check([file('d.md'), file('dev', { isRegular: false })])).toEqual({ ok: false, reason: 'non_regular', index: 1 });
  });

  it('lets a directory through', () => {
    expect(check([file('dir/', { isDirectory: true, isRegular: false, size: 0, compressedSize: 0 })])).toEqual({ ok: true });
  });
});

describe('the limits, at exactly their values and one past', () => {
  it('entry count: 20,000 pass, 20,001 fail, and the count is judged before any entry is looked at', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => file(`f${String(i)}.md`, { size: 1, compressedSize: 1 }));
    expect(check(many(limits.maxEntries), 1_000_000)).toEqual({ ok: true });
    expect(check(many(limits.maxEntries + 1), 1_000_000)).toEqual({ ok: false, reason: 'too_many_entries' });
    expect(check([...many(limits.maxEntries), file('../evil')], 1_000_000)).toEqual({ ok: false, reason: 'too_many_entries' });
  });

  it('declared total: 2 GiB passes, 2 GiB + 1 fails', () => {
    const half = limits.maxUncompressedBytes / 2;
    const entries = (extra: number) => [file('a.md', { size: half, compressedSize: half }), file('b.md', { size: half + extra, compressedSize: half + extra })];
    expect(check(entries(0), limits.maxUncompressedBytes)).toEqual({ ok: true });
    expect(check(entries(1), limits.maxUncompressedBytes)).toEqual({ ok: false, reason: 'too_large' });
    expect(check(entries(1), limits.maxUncompressedBytes + 1)).toEqual({ ok: false, reason: 'too_large' }); // a bigger archive does not make the total smaller
  });

  it('archive ratio: 100 passes, 101 fails', () => {
    expect(check([file('z.md', { size: 100_000, compressedSize: 100_000 })], 1000)).toEqual({ ok: true });
    expect(check([file('z.md', { size: 1000 * limits.maxRatio, compressedSize: 1000 })], 1000)).toEqual({ ok: true });
    expect(check([file('z.md', { size: 1000 * limits.maxRatio + 1, compressedSize: 1000 })], 1000)).toEqual({ ok: false, reason: 'ratio' });
  });

  it('entry ratio: 100 passes, 101 fails, in an archive whose own ratio is fine', () => {
    const big = file('big.md', { size: 100 * 1000, compressedSize: 1000 });
    const worse = file('worse.md', { size: 101 * 1000, compressedSize: 1000 });
    expect(check([big], 10_000_000)).toEqual({ ok: true });
    expect(check([big, worse], 10_000_000)).toEqual({ ok: false, reason: 'ratio', index: 1 });
  });

  it('an empty archive passes, and an entry with no compressed bytes is judged by its size alone', () => {
    expect(check([], 22)).toEqual({ ok: true });
    expect(check([file('empty.md', { size: 0, compressedSize: 0 })], 100)).toEqual({ ok: true });
    expect(check([file('lies.md', { size: 5, compressedSize: 0 })], 100)).toEqual({ ok: false, reason: 'ratio', index: 0 });
  });
});

describe('duplicate paths', () => {
  it('reports the later of two names that are equal once NFC-normalised and lower-cased', () => {
    expect([...duplicateIndexes(['A.md', 'x.md', 'a.md', 'caf\u00e9.md', 'cafe\u0301.md', 'a.md'])]).toEqual([2, 4, 5]);
    // `.` and empty segments name the same file as the path without them (a link resolves the same way)
    expect([...duplicateIndexes(['docs/page.md', 'docs/./page.md', 'docs//page.md', './docs/page.md', 'docs/other.md'])]).toEqual([1, 2, 3]);
    expect([...duplicateIndexes(['a.md', 'b.md'])]).toEqual([]);
  });
});

describe('a link inside a Markdown file', () => {
  it('is resolved against the file\'s folder, percent-decoded once, and never beyond the archive root', () => {
    expect(resolveLinkPath('%2e%2e/x', 'a/b.md')).toBe('x');
    expect(resolveLinkPath('%2e%2e/%2e%2e/%2e%2e/x', 'a/b.md')).toBeUndefined();
    expect(resolveLinkPath('../../x', 'a/b.md')).toBeUndefined();
    expect(resolveLinkPath('c.md', 'a/b.md')).toBe('a/c.md');
    expect(resolveLinkPath('./sub/../c.md', 'a/b.md')).toBe('a/c.md');
    expect(resolveLinkPath('c%20d.md', 'a/b.md')).toBe('a/c d.md');
    expect(resolveLinkPath('c.md', 'b.md')).toBe('c.md');
  });

  it('gives undefined when the joined result would read as a scheme or a drive, however it got there', () => {
    for (const url of ['sub/../C:/outside', 'C%3A/x', '%68ttps://x', 'a/../javascript:alert', 'D%3a%5cx']) expect(resolveLinkPath(url, 'b.md'), url).toBeUndefined();
    expect(resolveLinkPath('./a:b/c.md', 'dir/b.md'), 'a colon in a name below the root is a name').toBe('dir/a:b/c.md');
  });

  it('never returns a path whose first segment reads as a scheme or a drive: archive paths are not URLs', () => {
    expect(resolveLinkPath('./notes:2026.md', 'index.md'), 'a root entry called notes:2026.md cannot be linked to').toBeUndefined();
    expect(resolveLinkPath('./notes:2026.md', 'dir/index.md'), 'below the root the colon is inside a name').toBe('dir/notes:2026.md');
    for (const from of ['javascript:x/page.md', 'data:text/page.md', 'C:/dir/page.md', 'c:/page.md']) {
      expect(resolveLinkPath('y.md', from), from).toBeUndefined();
      expect(resolveLinkPath('./y/z.md', from), from).toBeUndefined();
      expect(resolveLinkPath('../y.md', from), from).toBeUndefined();
    }
  });

  it('judges a page path with . and empty segments as the path without them (what the header check accepts and the duplicate check merges)', () => {
    expect(resolveLinkPath('../x', './b.md')).toBeUndefined();
    expect(resolveLinkPath('../target.md', 'dir/./index.md')).toBe('target.md');
    expect(resolveLinkPath('c.md', 'dir//index.md')).toBe('dir/c.md');
    expect(resolveLinkPath('../c.md', 'a//b/./index.md')).toBe('a/c.md');
  });

  it('decodes once: a double-encoded dot stays a name, not a parent', () => {
    expect(resolveLinkPath('%252e%252e/x', 'a/b.md')).toBe('a/%2e%2e/x');
  });

  it('leaves out what is not a path inside the archive: a scheme, an absolute path, a drive, a backslash, a bad escape, a NUL, a fragment-only link', () => {
    for (const url of ['https://example.com/x', 'mailto:a@b.c', '/abs/x', 'c:\\x', 'a\\b', '%E0%A4%A', 'a%00b', '#top', '']) expect(resolveLinkPath(url, 'a/b.md'), url).toBeUndefined();
  });

  it('drops a query and a fragment, and normalises to NFC', () => {
    expect(resolveLinkPath('c.md#h', 'a/b.md')).toBe('a/c.md');
    expect(resolveLinkPath('c.md?x=1', 'a/b.md')).toBe('a/c.md');
    expect(resolveLinkPath('cafe\u0301.md', 'a/b.md')).toBe('a/caf\u00e9.md');
  });
});

describe('entries that are never imported', () => {
  it('are folders, macOS resource forks, .DS_Store and Thumbs.db, at any depth, and nothing else', () => {
    for (const [path, dir] of [['a/', true], ['a', true], ['__MACOSX/a/._b.md', false], ['x/.DS_Store', false], ['Thumbs.db', false], ['deep/er/Thumbs.db', false]] as const) expect(isIgnoredEntry(path, dir), path).toBe(true);
    for (const path of ['a.md', 'x/__MACOSX.md', 'DS_Store', 'thumbs.db.md', 'a/b/c.png']) expect(isIgnoredEntry(path, false), path).toBe(false);
  });
});

describe('what the report calls each reason', () => {
  it('skipped for the five that leave an entry out (a limit included: entry_too_large), failed for the three that could not read it', () => {
    expect(Object.entries(ITEM_FATE).filter(([, fate]) => fate === 'skipped').map(([reason]) => reason).sort()).toEqual(['duplicate_path', 'entry_too_large', 'ignored', 'nested_archive', 'too_large']);
    expect(Object.entries(ITEM_FATE).filter(([, fate]) => fate === 'failed').map(([reason]) => reason).sort()).toEqual(['bad_name', 'invalid_encoding', 'size_mismatch']);
  });
});
