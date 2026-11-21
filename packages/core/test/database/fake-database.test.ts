import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../../src/testing/fake-database.js';
import { databaseConformance } from '../../src/testing/database-conformance.js';

describe('FakeDatabase conformance (same cases as the Kysely adapter)', () => {
  // The cases build on each other (state carries over), so one database serves the whole list in order.
  const db = new FakeDatabase();
  for (const c of databaseConformance) it(c.name, () => c.run(db));
});

describe('FakeDatabase extras', () => {
  it('records statements and answers unknown ones from the handler', async () => {
    const db = new FakeDatabase(() => [{ x: 1 }]);
    expect(await db.query('select 1 as x from dual_x_y z', [])).toEqual([{ x: 1 }]);
    expect(await db.query('update t set a = $1', [5])).toEqual([{ x: 1 }]);
    expect(db.statements.at(-1)).toEqual({ sql: 'update t set a = $1', params: [5] });
  });
});
