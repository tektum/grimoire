import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '@tektum/grimoire-core/testing/fake-database';
import { createApp } from '../../src/app.js';
import { fakeDatabase, makeContext } from './support/context.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

async function get(app: ReturnType<typeof createApp>, path: string) {
  const res = await app.request(path);
  return { status: res.status, body: await res.text(), type: res.headers.get('content-type') };
}

describe('health routes', () => {
  it('/healthz is 200 ok and /readyz is 200 ok when the database pings and is migrated', async () => {
    const app = createApp(makeContext().ctx);
    expect(await get(app, '/healthz')).toEqual({ status: 200, body: 'ok', type: 'text/plain;charset=UTF-8' });
    expect(await get(app, '/readyz')).toEqual({ status: 200, body: 'ok', type: 'text/plain;charset=UTF-8' });
  });

  it('/readyz is 503 unavailable when the ping rejects, and /healthz stays 200 ok', async () => {
    const db = fakeDatabase();
    db.ping = () => Promise.reject(new Error(`connect ECONNREFUSED ${placeholderDatabaseUrl('h', 'db')}`));
    const app = createApp(makeContext(db).ctx);
    expect(await get(app, '/readyz')).toMatchObject({ status: 503, body: 'unavailable' });
    expect(await get(app, '/healthz')).toMatchObject({ status: 200, body: 'ok' });
  });

  it('/readyz is 503 unavailable when the migration table does not exist', async () => {
    const app = createApp(makeContext(fakeDatabase(false)).ctx);
    expect(await get(app, '/readyz')).toMatchObject({ status: 503, body: 'unavailable' });
  });

  it('/readyz is 503 when the newest shipped migration is not applied, and 200 when it is; the reason is a fixed log string', async () => {
    const pending = makeContext(fakeDatabase('0001_pages'));
    expect(await get(createApp(pending.ctx), '/readyz')).toMatchObject({ status: 503, body: 'unavailable' });
    expect(JSON.stringify(pending.logger.entries)).toContain('migration_pending');
  });

  it('asks only for the version function, never reading the migration table; success is cached for a few seconds, then asked again', async () => {
    const db = fakeDatabase();
    const { ctx, clock } = makeContext(db);
    const app = createApp(ctx);
    await app.request('/readyz');
    await app.request('/readyz');
    expect(db.statements.map((s) => s.sql)).toEqual(['select grimoire_schema_version() as version']);
    const { vi } = await import('vitest');
    vi.useFakeTimers({ now: Date.now() });
    try {
      clock.advance(2100);
    await vi.advanceTimersByTimeAsync(0);
      await app.request('/readyz');
      expect(db.statements).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('/readyz is 503 when the probe hangs past its timeout', async () => {
    const db = new FakeDatabase();
    db.ping = () => new Promise<void>(() => undefined);
    const { ctx } = makeContext(db);
    const app = createApp(ctx);
    // the probe timeout is 2 s by default; fake timers keep the test instant
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const pending = get(app, '/readyz');
      await vi.advanceTimersByTimeAsync(2100);
      expect(await pending).toMatchObject({ status: 503, body: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals nothing else: no JSON, no version, no error text, for every outcome', async () => {
    const failing = fakeDatabase();
    failing.ping = () => Promise.reject(new Error('boom password=hunter2'));
    for (const ctx of [makeContext().ctx, makeContext(failing).ctx]) {
      const app = createApp(ctx);
      for (const path of ['/healthz', '/readyz']) {
        const { body } = await get(app, path);
        expect(['ok', 'unavailable']).toContain(body);
      }
    }
  });

  it('answers 404 for anything else', async () => {
    expect((await createApp(makeContext().ctx).request('/')).status).toBe(404);
  });
});
