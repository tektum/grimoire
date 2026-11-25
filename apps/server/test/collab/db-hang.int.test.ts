import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dropTestDatabase, get, requireBuild, sqlAdmin, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { waitUntil } from '@tektum/grimoire-test-support/harness';
import { connect, eventually, newPage, pageRow, seedPage, StallProxy, synced, textOf, wsUrl } from './support.js';
import type { Client } from './support.js';

// A database that stops answering (queries neither return nor fail), simulated with a stalling proxy (see StallProxy).
const DB = 'grimoire_t09_hang';
let proxy: StallProxy;
const running: ServerProcess[] = [];
const clients: Client[] = [];
const hangEnv = {
  GRIMOIRE_COLLAB_DEBOUNCE_MS: '300', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '1000',
  GRIMOIRE_COLLAB_STORE_RETRY_BASE_MS: '200', GRIMOIRE_COLLAB_STORE_RETRY_MAX_MS: '1500',
  GRIMOIRE_COLLAB_STORE_TIMEOUT_MS: '800',
};
async function start(env: Record<string, string> = {}): Promise<ServerProcess> {
  const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: proxy.url(DB), ...hangEnv, ...env } });
  running.push(s);
  return s;
}
const client = (s: ServerProcess, name: string): Client => { const c = connect(wsUrl(s.port), name); clients.push(c); return c; };
const events = (s: ServerProcess, name: string) => s.events.filter((e) => e['event'] === name);
/** What the server logged after the signal, in order, with the measured time: a failed shutdown assertion says which phase ran long instead of only the number. */
function explainShutdown(after: readonly Record<string, unknown>[], ms: number, exit: { readonly code: number | null; readonly signal: string | null }): void {
  const lines = after.map((e) => JSON.stringify(e).slice(0, 400));
  console.error(`db-hang: shutdown took ${String(ms)} ms, exit code ${String(exit.code)}, signal ${String(exit.signal)}; the server logged ${String(lines.length)} lines after the signal:\n${lines.join('\n')}`);
}

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  proxy = await StallProxy.start();
}, 60_000);
afterEach(async () => {
  proxy.release();
  clients.splice(0).forEach((c) => { c.destroy(); });
  await Promise.all(running.splice(0).map((s) => s.kill()));
});
afterAll(async () => { await proxy.stop(); await dropTestDatabase(DB); });

describe('a database that hangs', () => {
  it('20 s stall during editing: store_failed with growing waits, one alarm after five failures, every edit stored after the stall, recovery signalled by collab.store_recovered', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const c = client(s, page); await synced(c);
    proxy.stall();
    // The typist edits every 500 ms through a 20 s stall (the child server's real clock); over the whole stall there is never a second alarm
    // nor a recovery, and either one ends the wait at once.
    let i = 0;
    const typing = setInterval(() => { c.text.insert(c.text.length, `${String(i++)},`); }, 500);
    const early = await waitUntil(() => events(s, 'collab.store_alarm').length > 1 || events(s, 'collab.store_recovered').length > 0, 20_000)
      .finally(() => { clearInterval(typing); });
    expect(early).toBe(false);
    const failed = events(s, 'collab.store_failed');
    expect(failed.length).toBeGreaterThanOrEqual(5);
    const waits = failed.map((e) => Number(e['retryInMs']));
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(1500);
    expect(events(s, 'collab.store_alarm')).toHaveLength(1);
    expect(events(s, 'collab.store_recovered')).toHaveLength(0);
    proxy.release();
    const expected = c.text.toString();
    await eventually(async () => (textOf((await pageRow(DB, page))?.ydoc) === expected ? true : undefined), 15_000, 'all edits stored after the stall');
    await eventually(() => (events(s, 'collab.store_recovered').length === 1 ? true : undefined), 10_000, 'recovery event');
    expect(events(s, 'collab.store_alarm')).toHaveLength(1);
  }, 60_000);

  it('SIGTERM while stalled with two unsaved pages and one saved page: two store_abandoned, exit 1, within the deadline plus two seconds, no connection left', async () => {
    // The job queue's stop waits on the stalled database for its whole grace (15 s by default); this test is about the page saves, so the grace is short and the release-jobs phase keeps its 2 s.
    const s = await start({ GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS: '3000', GRIMOIRE_SAVE_TIMEOUT_MS: '500', GRIMOIRE_JOBS_STOP_GRACE_MS: '1000' });
    const [saved, u1, u2] = [newPage(), newPage(), newPage()];
    await Promise.all([saved, u1, u2].map((p) => seedPage(DB, p)));
    const cs = [saved, u1, u2].map((p) => client(s, p));
    await Promise.all(cs.map((c) => synced(c)));
    cs[0]?.text.insert(0, 'saved before the stall');
    // The text itself, not any stored state: opening an empty page can store an initial state before the edit is saved, and the stall must start after the edit is in the row.
    await eventually(async () => (textOf((await pageRow(DB, saved))?.ydoc).includes('saved before the stall') ? true : undefined), 5000, 'first page stored with its edit');
    // The row is visible when the write commits, but the server learns of the save from the database's answer: a stall that starts before that answer has passed leaves it undelivered, and
    // the page counts as unsaved at SIGTERM. (This test's edit is not a valid editor document, so the server logs no `collab.saved` for it: there is no server-side signal to wait for.)
    // The database has sent its answer when every connection of the server is idle again; the proxy has passed it on when it has been quiet for a moment.
    await eventually(async () => {
      const busy = await sqlAdmin<{ n: string }>('postgres', `select count(*) as n from pg_stat_activity where datname = '${DB}' and usename = 'grimoire_app' and state <> 'idle'`);
      return Number(busy[0]?.n) === 0 && proxy.quietForMs() >= 300 ? true : undefined;
    }, 15_000, 'the database answered the first save and the answer passed the proxy');
    proxy.stall();
    cs[1]?.text.insert(0, 'unsaved one'); cs[2]?.text.insert(0, 'unsaved two');
    // Both stores have been tried and have hung up to their timeout: the retries are pending or in flight when the signal arrives.
    await eventually(() => ([u1, u2].every((p) => events(s, 'collab.store_failed').some((e) => e['pageId'] === p)) ? true : undefined), 5000, 'both stores hung');
    const seen = s.events.length;
    const t0 = Date.now();
    s.signal('SIGTERM');
    const exit = await s.exited;
    const ms = Date.now() - t0;
    try {
      expect(exit.code).toBe(1);
      const abandoned = events(s, 'collab.store_abandoned').map((e) => e['pageId']);
      expect(abandoned.sort()).toEqual([u1, u2].sort());
      expect(ms).toBeLessThan(3000 + 2000); // deadline + 2 s, the 1 s that keeps /readyz visible before connections close (R2.42) included
    } catch (error) {
      explainShutdown(s.events.slice(seen), ms, exit);
      throw error;
    }
    proxy.release();
    await eventually(async () => {
      const rows = await sqlAdmin<{ n: string }>('postgres', `select count(*) as n from pg_stat_activity where datname = '${DB}' and usename = 'grimoire_app'`);
      return Number(rows[0]?.n) === 0 ? true : undefined;
    }, 10_000, 'no connection of the server remains');
  }, 40_000);

  it('/readyz turns 503 within its probe timeout while stalled and recovers after', async () => {
    const s = await start();
    expect((await get(`${s.url}/readyz`)).status).toBe(200);
    proxy.stall();
    const t0 = Date.now();
    // A success is trusted for 2 s (the readiness cache), then the stalled probe times out after 2 s more.
    await eventually(async () => ((await get(`${s.url}/readyz`)).status === 503 ? true : undefined), 6000, '/readyz 503 while stalled');
    expect(Date.now() - t0).toBeLessThan(5000);
    proxy.release();
    await eventually(async () => ((await get(`${s.url}/readyz`)).status === 200 ? true : undefined), 10_000, 'ready again');
  }, 30_000);
});
