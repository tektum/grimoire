import { parse } from 'csv-parse/sync';

// constructed: [F§6]: a database exports as CSV; its handling is the provisional table mode (decision 7), not observed.

export type CsvResult = { readonly ok: true; readonly rows: string[][] } | { readonly ok: false; readonly reason: 'csv_field_too_large' | 'csv_malformed' | 'invalid_encoding' };

/**
 * constructed: [F§6] the rows of a CSV file: strict UTF-8, a byte order mark removed, every row as wide as the first, quotes balanced, and no record larger than `maxFieldBytes`
 * (a 50 MB field is refused, not read). The reason is a code; no cell is put in it.
 */
export function readCsv(bytes: Buffer, limits: { readonly maxFieldBytes: number }): CsvResult {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false, reason: 'invalid_encoding' }; }
  try {
    const rows = parse(text, { bom: true, max_record_size: limits.maxFieldBytes, relax_column_count: false, skip_empty_lines: true }) as string[][];
    return { ok: true, rows };
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : '';
    return { ok: false, reason: code === 'CSV_MAX_RECORD_SIZE' ? 'csv_field_too_large' : 'csv_malformed' };
  }
}

/** constructed: [F§6] what would break a Markdown table cell is escaped: a backslash, a pipe, and a line break, including a lone carriage return (written as a space). */
const cell = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r\n|\r|\n/g, ' ');

/** constructed: [F§6] a Markdown table: the first row is the header. A cell is text: a formula such as `=SUM(A1)` is written as it is and nothing evaluates it. */
export function csvToMarkdownTable(rows: readonly (readonly string[])[]): string {
  const [header, ...body] = rows;
  if (header === undefined) return '';
  const line = (r: readonly string[]): string => `| ${r.map(cell).join(' | ')} |\n`;
  return `${line(header)}| ${header.map(() => '---').join(' | ')} |\n${body.map(line).join('')}`;
}
