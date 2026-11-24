import { describe, expect, it } from 'vitest';
import { withMigrationLock } from '../src/index.js';
import type { LockClient } from '../src/index.js';

/** The session advisory lock of Postgres in memory: one holder at a time, the others wait; a connection that ends lets go of what it holds. */
function lockServer() {
  let holder: number | undefined;
  const waiting: Array<() => void> = [];
  let ended = 0;
  let nextId = 0;
  const free = () => { holder = undefined; waiting.shift()?.(); };
  const connect = (): Promise<LockClient> => {
    const id = (nextId += 1);
    return Promise.resolve({
      async query(text: string) {
        if (text.includes('pg_advisory_lock')) {
          while (holder !== undefined) await new Promise<void>((resolve) => waiting.push(resolve));
          holder = id;
        } else if (text.includes('pg_advisory_unlock') && holder === id) free();
      },
      end() { ended += 1; if (holder === id) free(); return Promise.resolve(); },
    });
  };
  return { connect, ended: () => ended, holder: () => holder };
}
/** Lets everything that is ready to run, run (promise callbacks only; no timer). */
const settle = async (): Promise<void> => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); };
const gate = () => { let open!: () => void; const opened = new Promise<void>((resolve) => { open = resolve; }); return { open, opened }; };

describe('the migration lock', () => {
  it('holds the lock while the work runs and lets go after it, closing its own connection', async () => {
    const server = lockServer();
    const seen: Array<number | undefined> = [];
    const result = await withMigrationLock('postgresql://unused', async () => { seen.push(server.holder()); return 7; }, server.connect);
    expect(result).toBe(7);
    expect(seen).toEqual([1]);
    expect(server.holder()).toBeUndefined();
    expect(server.ended()).toBe(1);
  });

  it('lets go and closes the connection when the work fails, and fails with the same error', async () => {
    const server = lockServer();
    const failure = new Error('a migration failed');
    await expect(withMigrationLock('postgresql://unused', () => Promise.reject(failure), server.connect)).rejects.toBe(failure);
    expect(server.holder()).toBeUndefined();
    expect(server.ended()).toBe(1);
  });

  it('makes a second caller wait until the first has finished, whatever the order they were started in', async () => {
    const server = lockServer();
    const events: string[] = [];
    const first = gate();
    const run = (name: string, hold?: Promise<void>) => withMigrationLock('postgresql://unused', async () => { events.push(`${name}:start`); await hold; events.push(`${name}:end`); }, server.connect);
    const all = Promise.all([run('a', first.opened), run('b'), run('c')]);
    await settle();
    expect(events).toEqual(['a:start']); // b and c are waiting, not racing
    first.open();
    await all;
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });
});
