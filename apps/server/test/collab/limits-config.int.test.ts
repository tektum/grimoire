import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appUrl, createTestDatabase, dropTestDatabase, requireBuild, startServer,
} from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { editor, RawClient, setPageState, stateOfSize, syncUpdateFrameOfSize } from './limits-support.js';
import type { Editor } from './limits-support.js';
import { waitUntil } from '@tektum/grimoire-test-support/harness';
import { eventually, newPage, seedPage, sleep, wsUrl } from './support.js';

/**
 * Each limit variable of the contracts, set through the environment of the real built server (so through `loadConfig`):
 * the same scenario gives a different outcome with the default and with the changed value.
 */
const DB = 'grimoire_t10_config';
const running: ServerProcess[] = [];
const editors: Editor[] = [];
const raws: RawClient[] = [];
const base = {
  GRIMOIRE_COLLAB_DEBOUNCE_MS: '300', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '1000',
  GRIMOIRE_COLLAB_CONNECT_ATTEMPTS_PER_WINDOW: '100000', GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS: '100000',
};
async function start(env: Record<string, string>): Promise<ServerProcess> {
  const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), ...base, ...env } });
  running.push(s);
  return s;
}
const edit = (s: ServerProcess, page: string): Editor => { const e = editor(wsUrl(s.port), page); editors.push(e); return e; };
const synced = (e: Editor): Promise<void> => eventually(() => (e.provider.synced ? true : undefined), 8000, 'synced').then(() => undefined);
const newSeeded = async (state?: Uint8Array): Promise<string> => { const id = newPage(); await seedPage(DB, id); if (state) await setPageState(DB, id, state); return id; };

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterEach(async () => {
  editors.splice(0).forEach((e) => { e.destroy(); });
  raws.splice(0).forEach((r) => { r.close(); });
  await Promise.all(running.splice(0).map((s) => s.kill()));
});
afterAll(async () => { await dropTestDatabase(DB); });

/** Sends a valid frame of `bytes` bytes on a raw socket and reports whether the server closed it with 1009. */
async function frameClosed(env: Record<string, string>, bytes: number): Promise<number | undefined> {
  const s = await start(env); const id = await newSeeded();
  const r = await RawClient.open(wsUrl(s.port), id); raws.push(r);
  r.send(syncUpdateFrameOfSize(id, bytes));
  await waitUntil(() => r.closed !== undefined, 1200); // a close ends the wait; an accepted frame takes the whole 1.2 s
  return r.closed?.code;
}
/** Pastes `chars` characters into a page stored at `stored` bytes: did the paste reach a second client? Also reports who was warned. */
async function paste(env: Record<string, string>, stored: number, chars: number): Promise<{ accepted: boolean; warned: boolean }> {
  const s = await start(env); const id = await newSeeded(stateOfSize(stored));
  const a = edit(s, id); const b = edit(s, id);
  await Promise.all([synced(a), synced(b)]);
  const before = b.text.length;
  a.text.insert(0, 'v'.repeat(chars));
  const outcome = (): { accepted: boolean; warned: boolean } => ({ accepted: b.text.length === before + chars, warned: a.stateless.some((m) => m.includes('state-warning')) });
  // Both seen ends the wait; a refused paste or a missing warning takes the whole 1.5 s.
  await waitUntil(() => { const o = outcome(); return o.accepted && o.warned; }, 1500);
  return outcome();
}
/** Sends `first`, waits `pauseMs`, sends `second` single-character edits from one client: the close codes it saw. */
async function burst(env: Record<string, string>, first: number, pauseMs: number, second: number): Promise<number[]> {
  const s = await start(env); const id = await newSeeded();
  const a = edit(s, id); await synced(a);
  // The 6 s window is a constant on the child server's real clock that no event marks and no setting changes (allow-listed).
  await sleep(6500); // past the 6 s reconnect-allowance window of a new connection
  for (let i = 0; i < first; i++) a.text.insert(a.text.length, 'x');
  await sleep(pauseMs);
  for (let i = 0; i < second; i++) a.text.insert(a.text.length, 'y');
  await waitUntil(() => a.closes.length > 0, 700); // a close ends the wait; none takes the whole 0.7 s
  return a.closes;
}
/** Opens `clients` connections to one page one after the other (a simultaneous burst may overshoot a count, R4.15): the distinct refusal reasons seen. */
async function refusal(env: Record<string, string>, clients: number): Promise<string[]> {
  const s = await start(env); const id = await newSeeded();
  const all: Editor[] = [];
  for (let i = 0; i < clients; i++) {
    const e = edit(s, id); all.push(e);
    await eventually(() => (e.provider.synced || e.failures.length > 0 ? true : undefined), 8000, 'synced or refused');
  }
  return [...new Set(all.flatMap((e) => e.failures))];
}

describe('limit variables change the outcome (through loadConfig on the built server)', () => {
  it('GRIMOIRE_COLLAB_MAX_PAYLOAD_BYTES: a 100 KB frame is closed with 1009 at 65536, accepted at the default', async () => {
    expect(await frameClosed({ GRIMOIRE_COLLAB_MAX_PAYLOAD_BYTES: '65536' }, 100_000)).toBe(1009);
    expect(await frameClosed({}, 100_000)).toBeUndefined();
  }, 30_000);

  it('GRIMOIRE_COLLAB_MAX_STATE_BYTES: a 10,000-character paste into a 15,000-byte page is refused at 20,000, accepted at the default', async () => {
    expect((await paste({ GRIMOIRE_COLLAB_MAX_STATE_BYTES: '20000' }, 15_000, 10_000)).accepted).toBe(false);
    expect((await paste({}, 15_000, 10_000)).accepted).toBe(true);
  }, 30_000);

  it('GRIMOIRE_COLLAB_STATE_WARN_PERCENT: a 15,000-byte page of a 20,000-byte cap is warned at 50%, not at 90%', async () => {
    const cap = { GRIMOIRE_COLLAB_MAX_STATE_BYTES: '20000' };
    expect((await paste({ ...cap, GRIMOIRE_COLLAB_STATE_WARN_PERCENT: '50' }, 15_000, 1)).warned).toBe(true);
    expect((await paste({ ...cap, GRIMOIRE_COLLAB_STATE_WARN_PERCENT: '90' }, 15_000, 1)).warned).toBe(false);
  }, 30_000);

  it('GRIMOIRE_COLLAB_MESSAGES_PER_WINDOW: 40 quick edits close the socket with 4429 at 20 per window, not at the default', async () => {
    expect(await burst({ GRIMOIRE_COLLAB_MESSAGES_PER_WINDOW: '20' }, 40, 0, 0)).toContain(4429);
    expect(await burst({}, 40, 0, 0)).not.toContain(4429);
  }, 30_000);

  it('GRIMOIRE_COLLAB_RATE_WINDOW_SECONDS: 15 edits, a 1.3 s pause, 15 more: closed at a 10 s window, fine at a 1 s window (20 per window)', async () => {
    const env = { GRIMOIRE_COLLAB_MESSAGES_PER_WINDOW: '20' };
    expect(await burst({ ...env, GRIMOIRE_COLLAB_RATE_WINDOW_SECONDS: '10' }, 15, 1300, 15)).toContain(4429);
    expect(await burst({ ...env, GRIMOIRE_COLLAB_RATE_WINDOW_SECONDS: '1' }, 15, 1300, 15)).not.toContain(4429);
  }, 30_000);

  it('GRIMOIRE_COLLAB_MAX_CONNECTIONS_PER_PAGE: the third connection to a page is refused at 2, accepted at the default', async () => {
    expect(await refusal({ GRIMOIRE_COLLAB_MAX_CONNECTIONS_PER_PAGE: '2' }, 3)).toEqual(['page-full']);
    expect(await refusal({}, 3)).toEqual([]);
  }, 30_000);

  it('GRIMOIRE_COLLAB_MAX_CONNECTIONS: the third connection is refused at 2 (server-full), accepted at the default', async () => {
    expect(await refusal({ GRIMOIRE_COLLAB_MAX_CONNECTIONS: '2' }, 3)).toEqual(['server-full']);
    expect(await refusal({}, 3)).toEqual([]);
  }, 30_000);

  it('GRIMOIRE_COLLAB_MAX_OPEN_DOCUMENTS: with 1 the second page is documents-full, accepted at the default', async () => {
    const two = async (env: Record<string, string>): Promise<string[]> => {
      const s = await start(env); const p1 = await newSeeded(); const p2 = await newSeeded();
      const a = edit(s, p1); await synced(a);
      const b = edit(s, p2);
      await waitUntil(() => b.failures.length > 0 || b.provider.synced, 1500); // refused or synced, whichever comes first
      return [...new Set(b.failures)];
    };
    expect(await two({ GRIMOIRE_COLLAB_MAX_OPEN_DOCUMENTS: '1' })).toEqual(['documents-full']);
    expect(await two({})).toEqual([]);
  }, 30_000);

  it('GRIMOIRE_COLLAB_MEMORY_LIMIT_BYTES: a page that is not open yet is refused with memory-guard at a 1,000-byte limit, accepted at the default', async () => {
    expect(await refusal({ GRIMOIRE_COLLAB_MEMORY_LIMIT_BYTES: '1000' }, 1)).toEqual(['memory-guard']);
    expect(await refusal({}, 1)).toEqual([]);
  }, 30_000);

  it('GRIMOIRE_COLLAB_MEMORY_GUARD_PERCENT: refused at 1% of the default limit (about 10 MB, below any running server), accepted at the default 80%', async () => {
    expect(await refusal({ GRIMOIRE_COLLAB_MEMORY_GUARD_PERCENT: '1' }, 1)).toEqual(['memory-guard']);
    expect(await refusal({}, 1)).toEqual([]);
  }, 30_000);
});
