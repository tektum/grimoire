import type { Database } from '@tektum/grimoire-core/ports/database';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { healthRoutes } from '../../src/health/routes.js';

// The operator pool opens its connections on first use: a wrong operator URL, password or a missing role must keep the task out of service.
const db: Database = {
  ping: () => Promise.resolve(),
  query<R>(): Promise<readonly R[]> { return Promise.resolve([{ version: '9999_test' }] as unknown as readonly R[]); },
  transaction<T>(): Promise<T> { return Promise.reject(new Error('unused')); },
  close: () => Promise.resolve(),
};

describe('/readyz and the operator pool', () => {
  it('answers 503 when the operator pool cannot run a statement and 200 when it can', async () => {
    const asked: string[] = [];
    let fails = true;
    const ops = {
      transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
        if (fails) return Promise.reject(new Error('password authentication failed'));
        return fn({ ...db, query<R>(sql: string): Promise<readonly R[]> { asked.push(sql); return Promise.resolve([] as readonly R[]); } });
      },
    };
    const clock = new FakeClock(1000);
    const app = healthRoutes({ db, ops, clock, log: createEventLog(new FakeLogger()), expectedMigration: '0001_test', isDraining: () => false });
    expect((await app.request('/readyz')).status).toBe(503);
    fails = false;
    clock.advance(1000);
    expect((await app.request('/readyz')).status).toBe(200);
    expect(asked).toEqual(['select 1']);
  });
});
