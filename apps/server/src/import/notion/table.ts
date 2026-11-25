import { parse } from 'csv-parse/sync';

// constructed: [F§6]: a database exports as CSV; its handling is the provisional table mode (decision 7), not observed.

export type CsvResult = { readonly ok: true; readonly rows: string[][] } | { readonly ok: false; readonly reason: 'csv_field_too_large' | 'csv_malformed' | 'invalid_encoding' };

/**
 * The rows of a CSV file: strict UTF-8, a byte order mark removed, and no record larger than `maxFieldBytes` (a 50 MB field is refused, not read). Rows of different widths are
 * read as they are (contracts section 4: ragged rows relaxed), and a quote inside a cell is text (M7-T08: a real export writes `"Ada" Lovelace` and `said "hi"` in its cells); a
 * quote that is opened and never closed is still refused. The reason is a code; no cell is put in it.
 */
export function readCsv(bytes: Buffer, limits: { readonly maxFieldBytes: number }): CsvResult {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false, reason: 'invalid_encoding' }; }
  try {
    const rows = parse(text, { bom: true, max_record_size: limits.maxFieldBytes, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }) as string[][];
    return { ok: true, rows };
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : '';
    return { ok: false, reason: code === 'CSV_MAX_RECORD_SIZE' ? 'csv_field_too_large' : 'csv_malformed' };
  }
}

/** constructed: [F§6] what would break a Markdown table cell is escaped: a backslash, a pipe, and a line break, including a lone carriage return (written as a space). */
const cell = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r\n|\r|\n/g, ' ');

/**
 * constructed: [F§6] a Markdown table: the first row is the header. A cell is text: a formula such as `=SUM(A1)` is written as it is and nothing evaluates it. Every row is as wide
 * as the widest (a Markdown table drops the cells past its header), so that no cell of a ragged CSV is lost.
 */
export function csvToMarkdownTable(rows: readonly (readonly string[])[]): string {
  const [header, ...body] = rows;
  if (header === undefined) return '';
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const line = (r: readonly string[]): string => `| ${[...r, ...Array.from({ length: width - r.length }, () => '')].map(cell).join(' | ')} |\n`;
  return `${line(header)}| ${Array.from({ length: width }, () => '---').join(' | ')} |\n${body.map(line).join('')}`;
}
