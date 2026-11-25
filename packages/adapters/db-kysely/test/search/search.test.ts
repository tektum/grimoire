import type { Database, Queryable } from '@tektum/grimoire-core/ports/database';
import { SearchTimeoutError } from '@tektum/grimoire-core/ports/search-repo';
import { describe, expect, it } from 'vitest';
import { createSearchRepo } from '../../src/search.js';

const row = (id: string) => ({ id, url_id: `u-${id}`, title: id, collection_id: 'c1', search_partial: false, edited_us: '1700000000000000', rank: 0.5 });

/** A database that answers the statements of one search in order: the two `set local`s, the search, the headlines. */
function stub(answers: { search?: unknown[]; headlines?: unknown[]; failWith?: unknown }): { db: Database; calls: { sql: string; params: readonly unknown[] | undefined }[] } {
  const calls: { sql: string; params: readonly unknown[] | undefined }[] = [];
  const tx: Queryable = {
    query: <R>(sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      if (answers.failWith !== undefined && /from pages p, \(select websearch/.test(sql)) return Promise.reject(answers.failWith);
      if (/ts_headline/.test(sql)) return Promise.resolve((answers.headlines ?? []) as R[]);
      if (/from pages p, \(select websearch/.test(sql)) return Promise.resolve((answers.search ?? []) as R[]);
      return Promise.resolve([] as R[]);
    },
  };
  return { db: { ...tx, transaction: (fn) => fn(tx), ping: () => Promise.resolve(), close: () => Promise.resolve() }, calls };
}
const ask = { tenantId: 'T', collectionIds: ['c1'], query: 'plan', limit: 10 } as const;

describe('createSearchRepo (against a stand-in database)', () => {
  it('leaves out a page that has no headline row because it was moved out of reach or trashed since the first statement', async () => {
    const { db, calls } = stub({ search: [row('p1'), row('p2')], headlines: [{ id: 'p1', headline: 'a \u0001plan\u0002', lead: 'a plan' }] });
    const page = await createSearchRepo(db, { statementTimeoutMs: 3000 }).search(ask);
    expect(page.hits.map((h) => h.pageId)).toEqual(['p1']);
    expect(page.hits[0]?.snippet).toEqual({ text: 'a plan', ranges: [[2, 6]] });
    const headlines = calls.find((c) => /ts_headline/.test(c.sql));
    expect(headlines?.sql).toMatch(/deleted_at is null and p\.collection_id = any\(\$4::uuid\[\]\)/);
    expect(headlines?.params).toEqual([['p1', 'p2'], 'plan', 'T', ['c1']]);
  });

  it('sets its own statement timeout and trigram threshold, from numbers it owns', async () => {
    const { db, calls } = stub({});
    await createSearchRepo(db, { statementTimeoutMs: 1234.9 }).search(ask);
    expect(calls.slice(0, 2).map((c) => c.sql)).toEqual(['set local statement_timeout = 1234', 'set local pg_trgm.similarity_threshold = 0.3']);
  });

  it('lets a title match by substring from two characters only when the query holds a character outside ASCII', async () => {
    const flags: unknown[] = [];
    for (const query of ['规划', 'qu', '规', 'ab', 'é', 'éa']) {
      const { db, calls } = stub({});
      await createSearchRepo(db, { statementTimeoutMs: 1 }).search({ ...ask, query });
      flags.push(calls.find((c) => /from pages p, \(select websearch/.test(c.sql))?.params?.[9]);
    }
    expect(flags).toEqual([true, false, false, false, false, true]);
  });

  it('escapes the characters ilike treats as its own, and binds the query instead of putting it in the statement', async () => {
    const { db, calls } = stub({});
    await createSearchRepo(db, { statementTimeoutMs: 1 }).search({ ...ask, query: "50%_\\'; drop table pages" });
    const search = calls.find((c) => /from pages p, \(select websearch/.test(c.sql));
    expect(search?.params?.[7]).toBe("50\\%\\_\\\\'; drop table pages");
    expect(search?.sql).not.toContain('drop table');
  });

  it('turns a cancelled statement, even one wrapped as a cause, into SearchTimeoutError, and passes other failures on', async () => {
    const cancelled = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    await expect(createSearchRepo(stub({ failWith: cancelled }).db, { statementTimeoutMs: 1 }).search(ask)).rejects.toBeInstanceOf(SearchTimeoutError);
    await expect(createSearchRepo(stub({ failWith: new Error('wrapped', { cause: cancelled }) }).db, { statementTimeoutMs: 1 }).search(ask)).rejects.toBeInstanceOf(SearchTimeoutError);
    await expect(createSearchRepo(stub({ failWith: new Error('other') }).db, { statementTimeoutMs: 1 }).search(ask)).rejects.toThrow('other');
  });

  it('gives a cursor for the last row of a full page, built from its rank, edit time and id', async () => {
    const rows = [{ ...row('0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e9999'), id: '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e9999' }, row('x')];
    const { db } = stub({ search: rows, headlines: rows.map((r) => ({ id: r.id, headline: null, lead: 'lead' })) });
    const page = await createSearchRepo(db, { statementTimeoutMs: 1 }).search({ ...ask, limit: 1 });
    expect(page.hits).toHaveLength(1);
    expect(JSON.parse(Buffer.from(page.nextCursor ?? '', 'base64url').toString())).toEqual({ k: [0.5, 1700000000000000, '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e9999'] });
  });
});
