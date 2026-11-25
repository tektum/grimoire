import { describe, expect, it } from 'vitest';
import { reasonText } from '../../src/screens/import/messages';

describe('the words of a table that could not become a page', () => {
  it('says why for each reason code of a database, with the size limit when the server gives it', () => {
    const limits = { markdownBytes: 2 * 1024 * 1024 };
    expect(reasonText({ status: 'skipped', message: 'database_row' }, limits)).toBe('This row only repeats what its table shows: it is in the table, not a page of its own.');
    expect(reasonText({ status: 'failed', message: 'table_too_large' }, limits)).toBe('The table is too large for one page: more than 1,000 rows, or more than 2 MB as a table.');
    expect(reasonText({ status: 'failed', message: 'table_too_large' }, {})).toBe('The table is too large for one page: more than 1,000 rows, or larger than the limit for a page as a table.');
    expect(reasonText({ status: 'failed', message: 'csv_malformed' }, limits)).toBe('The table could not be read.');
    expect(reasonText({ status: 'failed', message: 'csv_field_too_large' }, limits)).toBe('A cell of the table is too large.');
  });
});
