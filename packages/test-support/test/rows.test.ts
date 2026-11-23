import { describe, expect, it } from 'vitest';
import { insertCollection, insertPage, insertSql, insertUser, literal, raw, SYSTEM_USER_ID, UNFILED_COLLECTION_ID } from '../src/rows.ts';

const capture = (): { sql: string[]; run: (s: string) => Promise<void> } => {
  const sql: string[] = [];
  return { sql, run: (s) => { sql.push(s); return Promise.resolve(); } };
};

describe('literal', () => {
  it('doubles quotes so a value cannot end the string', () => {
    expect(literal("it's '; drop table pages; --")).toBe("'it''s ''; drop table pages; --'");
  });
  it('writes bytes as a hex bytea, null, numbers, dates and raw expressions as given', () => {
    expect(literal(new Uint8Array([1, 2, 255]))).toBe("'\\x0102ff'");
    expect(literal(null)).toBe('null');
    expect(literal(7)).toBe('7');
    expect(literal(new Date('2026-01-02T03:04:05.000Z'))).toBe("'2026-01-02T03:04:05.000Z'");
    expect(literal(raw('now()'))).toBe('now()');
  });
});

describe('insertSql', () => {
  it('rejects a table or column name that is not a plain identifier', () => {
    expect(() => insertSql('pages', { 'id; drop table pages': 'x' })).toThrow('Invalid SQL identifier');
    expect(() => insertSql('pages x', { id: 'x' })).toThrow('Invalid SQL identifier');
  });
});

describe('insertPage', () => {
  it('names the collection and the author explicitly (Unfiled, system user) and leaves every other column to its default', async () => {
    const { sql, run } = capture();
    const id = await insertPage(run);
    expect(sql).toEqual([`insert into pages (collection_id, created_by, id) values ('${UNFILED_COLLECTION_ID}', '${SYSTEM_USER_ID}', '${id}')`]);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
  it('uses the given id, collection, author and columns, and returns the given id', async () => {
    const { sql, run } = capture();
    const id = await insertPage(run, { id: 'p1', collection_id: 'c1', created_by: 'u1', title: 'T', markdown: 'x', ydoc: new Uint8Array([1]) });
    expect(id).toBe('p1');
    expect(sql[0]).toBe("insert into pages (collection_id, created_by, id, title, markdown, ydoc) values ('c1', 'u1', 'p1', 'T', 'x', '\\x01')");
  });
});

describe('insertCollection and insertUser', () => {
  it('give a collection the system user as author and a user a unique identity', async () => {
    const { sql, run } = capture();
    const c = await insertCollection(run, { default_permission: 'read_write' });
    const a = await insertUser(run);
    const b = await insertUser(run, { role: 'admin' });
    expect(sql[0]).toContain(`'${SYSTEM_USER_ID}'`);
    expect(sql[0]).toContain('into collections');
    expect(sql[0]).toContain(`'${c}'`);
    expect(a).not.toBe(b);
    expect(sql[2]).toContain("'admin'");
    expect(sql[1]).toContain('descope_user_id');
  });
});
