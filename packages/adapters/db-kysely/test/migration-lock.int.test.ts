import { describe, expect, it, vi } from 'vitest';
import { createDatabase, withMigrationLock } from '../src/index.js';

// The real lock of Postgres, on the development server's maintenance database (it creates nothing): a second worker waits for the first.
const url = 'postgresql://grimoire_admin:grimoire-dev@127.0.0.1:55432/postgres';

describe('the migration lock on Postgres', () => {
  it('makes a second worker wait for the first, and is free again after a failure', async () => {
    const watcher = createDatabase(url, { maxConnections: 1 });
    try {
      const events: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const first = withMigrationLock(url, async () => { events.push('a:start'); await held; events.push('a:end'); });
      await vi.waitFor(() => expect(events).toEqual(['a:start']));
      const second = withMigrationLock(url, () => { events.push('b:start'); return Promise.resolve(); });
      // The second worker's request for the lock is queued on the server, not granted.
      await vi.waitFor(async () => {
        const rows = await watcher.query<{ waiting: string }>(`select count(*)::text as waiting from pg_locks where locktype = 'advisory' and not granted`);
        expect(rows[0]?.waiting).toBe('1');
      });
      expect(events).toEqual(['a:start']);
      release();
      await Promise.all([first, second]);
      expect(events).toEqual(['a:start', 'a:end', 'b:start']);
      await expect(withMigrationLock(url, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      await expect(withMigrationLock(url, () => Promise.resolve('after'))).resolves.toBe('after');
    } finally {
      await watcher.close();
    }
  }, 30_000);
});
