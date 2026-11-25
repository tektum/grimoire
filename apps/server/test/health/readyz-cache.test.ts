import type { Database } from '@tektum/grimoire-core/ports/database';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { createEventLog } from '../../src/events.js';
import { healthRoutes } from '../../src/health/routes.js';

/** An operator pool that answers. */
const ops = { transaction: () => Promise.resolve(undefined as never) };

describe('/readyz failure cache', () => {
  it('five failing probes in one second check the database once and a success caches two seconds', async () => {
    const clock = new FakeClock(1000);
    let checks = 0;
    let fails = true;
    const db: Database = {
      async ping(): Promise<void> { checks++; if (fails) throw new Error('not returned'); },
      async query<R>(): Promise<readonly R[]> { return [{ version: '9999_test' }] as unknown as readonly R[]; },
      async transaction<T>(): Promise<T> { throw new Error('unused'); },
      async close(): Promise<void> { },
    };
    const app = healthRoutes({ db, ops, clock, log: createEventLog(new FakeLogger()), expectedMigration: '0001_test', isDraining: () => false });
    vi.useFakeTimers({ now: 1000 });
    try {
      for (let i = 0; i < 5; i++) expect((await app.request('/readyz')).status).toBe(503);
      expect(checks).toBe(1);
      clock.advance(999);
      await app.request('/readyz');
      expect(checks).toBe(1);
      clock.advance(1);
      fails = false;
      expect((await app.request('/readyz')).status).toBe(200);
      expect(checks).toBe(2);
      for (let i = 0; i < 5; i++) expect((await app.request('/readyz')).status).toBe(200);
      expect(checks).toBe(2);
      clock.advance(2001);
      await app.request('/readyz');
      expect(checks).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  const hungDb = (counter: { n: number }): Database => ({
    ping(): Promise<void> { counter.n++; return new Promise(() => undefined); },
    async query<R>(): Promise<readonly R[]> { return []; },
    async transaction<T>(): Promise<T> { throw new Error('unused'); },
    async close(): Promise<void> { },
  });

  it('probes that arrive together share one database check, and a hung database that timed out is not asked again for a second', async () => {
    const clock = new FakeClock(1000);
    const counter = { n: 0 };
    const app = healthRoutes({ db: hungDb(counter), ops, clock, log: createEventLog(new FakeLogger()), expectedMigration: '0001_test', isDraining: () => false, probeTimeoutMs: 100 });
    vi.useFakeTimers({ now: 1000 });
    try {
      const five = Array.from({ length: 5 }, () => app.request('/readyz'));
      await vi.advanceTimersByTimeAsync(100);
      expect((await Promise.all(five)).map((r) => r.status)).toEqual([503, 503, 503, 503, 503]);
      expect(counter.n).toBe(1);
      const later = app.request('/readyz');
      expect((await later).status).toBe(503);
      expect(counter.n).toBe(1); // inside the failure cache: no new check against the hung pool
      clock.advance(1000);
      const next = app.request('/readyz');
      await vi.advanceTimersByTimeAsync(100);
      expect((await next).status).toBe(503);
      // The earlier check is still hung inside the pool: this probe joined it instead of starting a second one on another connection.
      expect(counter.n).toBe(1);
      for (let round = 0; round < 5; round++) {
        clock.advance(1000);
        const again = app.request('/readyz');
        await vi.advanceTimersByTimeAsync(100);
        expect((await again).status).toBe(503);
      }
      expect(counter.n).toBe(1); // five more probe rounds against the same hung database: still one query in flight
    } finally { vi.useRealTimers(); }
  });
});

describe('/readyz after a hung check ends', () => {
  it('a probe asks the database again once the earlier query has settled', async () => {
    const clock = new FakeClock(1000);
    const counter = { n: 0 };
    let release: () => void = () => undefined;
    const db: Database = {
      ping(): Promise<void> { counter.n++; return new Promise<void>((resolve) => { release = resolve; }); },
      async query<R>(): Promise<readonly R[]> { return [{ version: '9999_test' }] as unknown as readonly R[]; },
      async transaction<T>(): Promise<T> { throw new Error('unused'); },
      async close(): Promise<void> { },
    };
    const app = healthRoutes({ db, ops, clock, log: createEventLog(new FakeLogger()), expectedMigration: '0001_test', isDraining: () => false, probeTimeoutMs: 100 });
    vi.useFakeTimers({ now: 1000 });
    try {
      const first = app.request('/readyz');
      await vi.advanceTimersByTimeAsync(100);
      expect((await first).status).toBe(503);
      release(); // the database answers at last
      await vi.advanceTimersByTimeAsync(0);
      clock.advance(2000);
      const second = app.request('/readyz');
      await vi.advanceTimersByTimeAsync(0);
      expect(counter.n).toBe(2); // a new check, because nothing is in flight any more
      release();
      expect((await second).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });
});
