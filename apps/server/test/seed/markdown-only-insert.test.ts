import { describe, expect, it } from 'vitest';
import { insertMarkdownOnlyPageUnsafeForUserText } from '../../src/seed/index.js';
import { SEED_PAGES } from '../../src/seed/data.js';

// Spec R7.13: a row of Markdown with no state is rebuilt with the lenient `reseed` limits, so only this named function may create one (dev seed data).
describe('the one writer of a page row with Markdown and no state', () => {
  it('inserts the Markdown and its text and leaves the state (ydoc) out', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const page = SEED_PAGES[0]!;
    await insertMarkdownOnlyPageUnsafeForUserText({ query: (sql, params) => { calls.push({ sql, params }); return Promise.resolve(); } }, page);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('insert into pages');
    expect(calls[0]!.sql).not.toContain('ydoc');
    expect(calls[0]!.params).toContain(page.markdown);
  });
});
