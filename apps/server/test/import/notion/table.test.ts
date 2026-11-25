import { describe, expect, it } from 'vitest';
import { csvToMarkdownTable, readCsv } from '../../../src/import/notion/table.js';

// M7-T06 (decision 7: table mode only): a database CSV becomes a Markdown table. Constructed, not observed.
describe('readCsv', () => {
  it('reads rows, removing a byte order mark', () => {
    expect(readCsv(Buffer.from('\ufeffName,Status\n"Write, plan",Done\n'), { maxFieldBytes: 1000 })).toEqual({ ok: true, rows: [['Name', 'Status'], ['Write, plan', 'Done']] });
  });

  it('refuses a field over the limit, unbalanced quotes, and rows of different widths, by reason', () => {
    expect(readCsv(Buffer.from(`a,${'x'.repeat(2000)}\n`), { maxFieldBytes: 1000 })).toEqual({ ok: false, reason: 'csv_field_too_large' });
    expect(readCsv(Buffer.from('a,"b\nc,d\n'), { maxFieldBytes: 1000 })).toEqual({ ok: false, reason: 'csv_malformed' });
    expect(readCsv(Buffer.from('a,b\nc\n'), { maxFieldBytes: 1000 })).toEqual({ ok: false, reason: 'csv_malformed' });
  });

  it('judges the limit in bytes, not characters: 400 characters of CJK text are 1,200 bytes', () => {
    expect(readCsv(Buffer.from(`a,${'\u6f22'.repeat(400)}\n`), { maxFieldBytes: 1000 })).toEqual({ ok: false, reason: 'csv_field_too_large' });
    expect(readCsv(Buffer.from(`a,${'\u6f22'.repeat(300)}\n`), { maxFieldBytes: 1000 }).ok).toBe(true);
  });

  it('refuses text that is not UTF-8', () => {
    expect(readCsv(Buffer.from([0x61, 0x2c, 0xff, 0x0a]), { maxFieldBytes: 1000 })).toEqual({ ok: false, reason: 'invalid_encoding' });
  });
});

describe('csvToMarkdownTable', () => {
  it('writes a header, a separator and a line per row; a formula stays the text it is', () => {
    expect(csvToMarkdownTable([['Name', 'Value'], ['a', '=SUM(A1)'], ['b', '2']])).toBe('| Name | Value |\n| --- | --- |\n| a | =SUM(A1) |\n| b | 2 |\n');
  });

  it('escapes what would break a cell: a pipe, a newline, a backslash', () => {
    expect(csvToMarkdownTable([['H'], ['a|b'], ['line\nbreak'], ['back\\slash']])).toBe('| H |\n| --- |\n| a\\|b |\n| line break |\n| back\\\\slash |\n');
  });

  it('a lone carriage return in a cell is a space too (CommonMark counts it as a line ending)', () => {
    expect(csvToMarkdownTable([['H'], ['a\rb'], ['c\r\nd']])).toBe('| H |\n| --- |\n| a b |\n| c d |\n');
  });

  it('a table with only a header has the header and the separator', () => {
    expect(csvToMarkdownTable([['A', 'B']])).toBe('| A | B |\n| --- | --- |\n');
  });

  it('is the empty string for no rows', () => {
    expect(csvToMarkdownTable([])).toBe('');
  });
});
