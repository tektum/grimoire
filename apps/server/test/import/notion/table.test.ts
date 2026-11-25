import { describe, expect, it } from 'vitest';
import { csvToMarkdownTable, readCsv } from '../../../src/import/notion/table.js';

// M7-T06 (decision 7: table mode only): a database CSV becomes a Markdown table. Constructed, not observed.
describe('readCsv', () => {
  it('reads rows, removing a byte order mark', () => {
    expect(readCsv(Buffer.from('\ufeffName,Status\n"Write, plan",Done\n'), { maxFieldBytes: 1000 })).toEqual({ ok: true, rows: [['Name', 'Status'], ['Write, plan', 'Done']] });
  });

  it('refuses a field over the limit and a quote that is never closed, by reason', () => {
    expect(readCsv(Buffer.from(`a,${'x'.repeat(2000)}\n`), { maxFieldBytes: 1000 })).toEqual({ ok: false, reason: 'csv_field_too_large' });
    expect(readCsv(Buffer.from('a,"b\nc,d\n'), { maxFieldBytes: 1000 })).toEqual({ ok: false, reason: 'csv_malformed' });
  });

  it('reads rows of different widths (ragged rows are relaxed, contracts section 4) as they are', () => {
    expect(readCsv(Buffer.from('a,b\nc\nd,e,f\n'), { maxFieldBytes: 1000 })).toEqual({ ok: true, rows: [['a', 'b'], ['c'], ['d', 'e', 'f']] });
  });

  it('reads a quote inside a cell as text, as a real export writes it (M7-T08): after a quoted value, and inside a value that is not quoted', () => {
    expect(readCsv(Buffer.from('Name,Note\n"Ada" Lovelace,said "hi" twice\n'), { maxFieldBytes: 1000 })).toEqual({ ok: true, rows: [['Name', 'Note'], ['"Ada" Lovelace', 'said "hi" twice']] });
  });

  it('judges the limit in bytes, not characters: 400 characters of CJK text are 1,200 bytes', () => {
    expect(readCsv(Buffer.from(`a,${'\u6f22'.repeat(400)}\n`), { maxFieldBytes: 1000 })).toEqual({ ok: false, reason: 'csv_field_too_large' });
    expect(readCsv(Buffer.from(`a,${'\u6f22'.repeat(300)}\n`), { maxFieldBytes: 1000 }).ok).toBe(true);
  });

  it('refuses text that is not UTF-8', () => {
    expect(readCsv(Buffer.from([0x61, 0x2c, 0xff, 0x0a]), { maxFieldBytes: 1000 })).toEqual({ ok: false, reason: 'invalid_encoding' });
  });
});

const CAP = 262_144;

describe('csvToMarkdownTable', () => {
  it('writes a header, a separator and a line per row; a formula stays the text it is', () => {
    expect(csvToMarkdownTable([['Name', 'Value'], ['a', '=SUM(A1)'], ['b', '2']], CAP)).toBe('| Name | Value |\n| --- | --- |\n| a | =SUM(A1) |\n| b | 2 |\n');
  });

  it('makes every row as wide as the widest, so that no cell of a ragged CSV is lost (a Markdown table drops the cells past its header)', () => {
    expect(csvToMarkdownTable([['H1', 'H2'], ['a'], ['b', 'c', 'd']], CAP)).toBe('| H1 | H2 |  |\n| --- | --- | --- |\n| a |  |  |\n| b | c | d |\n');
  });

  it('is no table when the table would be over the cap, judged before it is made: one very wide row cannot make every row that wide', () => {
    const wide = Array.from({ length: 100_000 }, () => '');
    const rows = [['Name'], wide, ...Array.from({ length: 1000 }, (_v, i) => [`r${String(i)}`])];
    expect(csvToMarkdownTable(rows, CAP)).toBeUndefined();
    expect(csvToMarkdownTable([['Name'], ['x'.repeat(CAP)]], CAP)).toBeUndefined(); // over the cap by its own cells
    expect(csvToMarkdownTable([['Name'], ['x']], CAP)).toBe('| Name |\n| --- |\n| x |\n');
  });

  it('escapes what would break a cell: a pipe, a newline, a backslash', () => {
    expect(csvToMarkdownTable([['H'], ['a|b'], ['line\nbreak'], ['back\\slash']], CAP)).toBe('| H |\n| --- |\n| a\\|b |\n| line break |\n| back\\\\slash |\n');
  });

  it('a lone carriage return in a cell is a space too (CommonMark counts it as a line ending)', () => {
    expect(csvToMarkdownTable([['H'], ['a\rb'], ['c\r\nd']], CAP)).toBe('| H |\n| --- |\n| a b |\n| c d |\n');
  });

  it('a table with only a header has the header and the separator', () => {
    expect(csvToMarkdownTable([['A', 'B']], CAP)).toBe('| A | B |\n| --- | --- |\n');
  });

  it('is the empty string for no rows', () => {
    expect(csvToMarkdownTable([], CAP)).toBe('');
  });
});
