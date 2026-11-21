import assert from 'node:assert/strict';
import type { Database } from '../ports/database.js';

/**
 * Behaviour every Database implementation must show. The same cases run on the fake (unit) and on the
 * real adapter (integration); the adapter's test creates the table `conformance_items(id int, name text)` first.
 * Uses node:assert so core's testing folder does not depend on a test runner.
 */
export interface ConformanceCase { readonly name: string; run(db: Database): Promise<void> }

const SELECT = 'select id, name from conformance_items order by id';
const INSERT = 'insert into conformance_items (id, name) values ($1, $2)';

export const databaseConformance: readonly ConformanceCase[] = [
  {
    name: 'query returns rows written earlier',
    async run(db) {
      await db.query(INSERT, [1, 'a']);
      assert.deepEqual(await db.query(SELECT), [{ id: 1, name: 'a' }]);
    },
  },
  {
    name: 'a transaction that resolves is committed and returns its value',
    async run(db) {
      const value = await db.transaction(async (tx) => {
        await tx.query(INSERT, [2, 'b']);
        return 42;
      });
      assert.equal(value, 42);
      assert.deepEqual((await db.query<{ id: number }>(SELECT)).map((r) => r.id), [1, 2]);
    },
  },
  {
    name: 'a transaction that rejects is rolled back and the error is rethrown',
    async run(db) {
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.query(INSERT, [3, 'c']);
          throw new Error('boom');
        }),
        /boom/,
      );
      assert.deepEqual((await db.query<{ id: number }>(SELECT)).map((r) => r.id), [1, 2]);
    },
  },
  {
    name: 'ping resolves while the database is open',
    async run(db) {
      await db.ping();
    },
  },
  {
    name: 'close can be called twice and leaves the database unusable',
    async run(db) {
      await db.close();
      await db.close();
      await assert.rejects(db.query(SELECT));
      await assert.rejects(db.ping());
    },
  },
];
