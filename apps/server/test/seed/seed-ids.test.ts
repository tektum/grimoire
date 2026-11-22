import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '@tektum/grimoire-core/testing/fake-database';
import { seedLocal } from '../../src/seed/index.js';
import { ALICE, BOB } from '../../src/seed/data.js';

// The seed builds on the user rows that exist for its subjects (a local sign-in may have made them under other ids): which id each later insert uses.
const idsUsed = (db: FakeDatabase, table: string): unknown[] =>
  db.statements.filter((s) => s.sql.includes(`insert into ${table}`)).map((s) => s.params[s.params.length - 1]);

describe('seedLocal ids', () => {
  it('uses the ids of the rows that already exist for alice and bob', async () => {
    const existing = new Map([['alice', 'existing-alice'], ['bob', 'existing-bob']]);
    const db = new FakeDatabase((sql, params) => (sql.startsWith('select id from users') ? [{ id: existing.get(params[0] as string) ?? 'other' }] : []));
    await seedLocal(db);
    expect(idsUsed(db, 'collections').every((id) => id === 'existing-alice')).toBe(true);
    expect(idsUsed(db, 'pages').every((id) => id === 'existing-alice')).toBe(true);
    expect(db.statements.find((s) => s.sql.includes('insert into collection_access'))?.params[2]).toBe('existing-bob');
  });

  it('falls back to the fixed seed ids when no row can be read back', async () => {
    const db = new FakeDatabase(() => []);
    await seedLocal(db);
    expect(idsUsed(db, 'collections').every((id) => id === ALICE)).toBe(true);
    expect(db.statements.find((s) => s.sql.includes('insert into collection_access'))?.params[2]).toBe(BOB);
  });
});
