import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appUrl, createTestDatabase, dropTestDatabase, requireBuild, startServer,
} from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { editor, RawClient, setPageState, stateOfSize, syncUpdateFrame, syncUpdateFrameOfSize } from './limits-support.js';
import type { Editor } from './limits-support.js';
import { eventually, newPage, pageRow, seedPage, sleep, textOf, wsUrl } from './support.js';

const DB = 'grimoire_t10_limits';
const running: ServerProcess[] = [];
const editors: Editor[] = [];
const raws: RawClient[] = [];
/** Fast saves, and the per-address connection limits of the upgrade guard out of the way: this file tests the limits of the collaboration extension. */
const base = {
  GRIMOIRE_COLLAB_DEBOUNCE_MS: '300', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '1000',
  GRIMOIRE_COLLAB_CONNECT_ATTEMPTS_PER_WINDOW: '100000', GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS: '100000',
};
async function start(env: Record<string, string> = {}): Promise<ServerProcess> {
  const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), ...base, ...env } });
  running.push(s);
  return s;
}
const edit = (s: ServerProcess, page: string, token?: string): Editor => { const e = editor(wsUrl(s.port), page, token); editors.push(e); return e; };
const raw = async (s: ServerProcess, page: string): Promise<RawClient> => { const r = await RawClient.open(wsUrl(s.port), page); raws.push(r); return r; };
const synced = (e: Editor): Promise<void> => eventually(() => (e.provider.synced ? true : undefined), 8000, 'provider synced').then(() => undefined);
const events = (s: ServerProcess, name: string) => s.events.filter((e) => e['event'] === name);
const hits = (s: ServerProcess, limit: string) => events(s, 'collab.limit_hit').filter((e) => e['limit'] === limit);
const page = async (): Promise<string> => { const id = newPage(); await seedPage(DB, id); return id; };
const stored = async (id: string) => (await pageRow(DB, id))?.ydoc ?? null;
const waitFailure = (e: Editor, reason: string): Promise<void> => eventually(() => (e.failures.includes(reason) ? true : undefined), 8000, `refusal ${reason}`).then(() => undefined);
const textIs = (e: Editor, text: string): Promise<void> => eventually(() => (e.text.toString() === text ? true : undefined), 8000, `text ${text.slice(0, 20)}`).then(() => undefined);
const count = (e: Editor, payload: string): number => e.stateless.filter((m) => m.includes(payload)).length;

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterEach(async () => {
  editors.splice(0).forEach((e) => { e.destroy(); });
  raws.splice(0).forEach((r) => { r.close(); });
  await Promise.all(running.splice(0).map((s) => s.kill()));
});
afterAll(async () => { await dropTestDatabase(DB); });

describe('message size: maxPayload (R4.16)', () => {
  it('a 2 MB frame closes that socket with 1009, a frame of exactly 1,048,576 bytes is accepted, and a new client loads the page with its text', async () => {
    // The page-size cap is raised here: a frame of exactly the message limit (1,048,576 bytes) is also a page over the default cap, and this test is about the message limit.
    const s = await start({ GRIMOIRE_COLLAB_MAX_STATE_BYTES: '2000000' }); const id = await page();
    const alice = edit(s, id); await synced(alice);
    alice.text.insert(0, 'hello');
    await eventually(async () => (textOf(await stored(id)) === 'hello' ? true : undefined), 8000, 'hello stored');

    const big = await raw(s, id);
    big.send(new Uint8Array(2 * 1024 * 1024));
    await eventually(() => big.closed, 5000, 'oversize socket closed');
    expect(big.closed?.code).toBe(1009);
    expect(hits(s, 'message-size')).toEqual([expect.objectContaining({ limit: 'message-size', max: 1_048_576 })]);
    alice.text.insert(5, '!');
    await textIs(alice, 'hello!');

    const exact = await raw(s, id);
    const frame = syncUpdateFrameOfSize(id, 1_048_576);
    expect(frame.length).toBe(1_048_576);
    exact.send(frame);
    await eventually(() => (alice.text.length > 1_000_000 ? true : undefined), 8000, 'the exact-size frame was applied');
    expect(exact.closed).toBeUndefined();
    expect(hits(s, 'message-size')).toHaveLength(1);

    const fresh = edit(s, id); await synced(fresh);
    expect(fresh.text.toString()).toContain('hello!');
    expect(fresh.text.length).toBe(alice.text.length);
  }, 30_000);
});

describe('malformed updates (R4.17)', () => {
  it.each(['garbage', 'truncated'])('a %s update inside a valid sync frame: malformed-update, nothing stored, other client and new client unaffected', async (kind) => {
    const s = await start(); const id = await page();
    const alice = edit(s, id); await synced(alice);
    alice.text.insert(0, 'hello');
    await eventually(async () => (textOf(await stored(id)) === 'hello' ? true : undefined), 8000, 'hello stored');
    const before = Buffer.from((await stored(id)) ?? new Uint8Array()).toString('hex');

    const bad = await raw(s, id);
    const valid = Y.encodeStateAsUpdate(alice.provider.document);
    const payload = kind === 'garbage' ? Uint8Array.from({ length: 64 }, (_, i) => 255 - (i % 7)) : valid.slice(0, valid.length - 3);
    bad.send(syncUpdateFrame(id, payload));
    await eventually(() => (bad.stateless.find((m) => m.includes('malformed-update'))), 5000, 'malformed-update message');
    expect(JSON.parse(bad.stateless[0] ?? '{}')).toEqual({ grimoire: 1, kind: 'refusal', code: 'malformed-update' });
    expect(events(s, 'collab.refused').map((e) => e['code'])).toEqual(['malformed-update']);
    expect(Buffer.from((await stored(id)) ?? new Uint8Array()).toString('hex')).toBe(before);
    expect(alice.text.toString()).toBe('hello');
    alice.text.insert(5, '?');
    await eventually(async () => (textOf(await stored(id)) === 'hello?' ? true : undefined), 8000, 'the other client still saves');
    // That save was written after the bad frame: the stored state holds alice's edits and nothing from any other client.
    expect(Y.decodeStateVector(Y.encodeStateVectorFromUpdate((await stored(id)) ?? new Uint8Array()))).toEqual(Y.decodeStateVector(Y.encodeStateVector(alice.provider.document)));
    const fresh = edit(s, id); await synced(fresh);
    expect(fresh.text.toString()).toBe('hello?');
  }, 30_000);
});

/** The default state cap of the server under test (the setting is not changed here). */
const STATE_CAP = 1_000_000;

describe('state cap and warning (R4.16, R4.47, R3.18)', () => {
  it('a page stored near the state cap (1,000,000 bytes by default) refuses a paste that would pass it, stays readable and editable, and each editor gets one state-warning', async () => {
    const s = await start(); const id = await page();
    const seed = stateOfSize(STATE_CAP - 36_000);
    await setPageState(DB, id, seed);
    const a = edit(s, id); const b = edit(s, id);
    await Promise.all([synced(a), synced(b)]);
    const start0 = b.text.length;
    expect(start0).toBeGreaterThan(STATE_CAP - 100_000);

    a.text.insert(0, 'v'.repeat(100_000)); // one update of about 100 KB: well under maxPayload, over the cap
    await eventually(() => (count(a, 'state-cap') > 0 ? true : undefined), 8000, 'state-cap message to the sender');
    expect(JSON.parse(a.stateless.find((m) => m.includes('state-cap')) ?? '{}')).toEqual({ grimoire: 1, kind: 'refusal', code: 'state-cap' });
    // The server refused the update before applying it: a client that syncs now sees the stored page, so nothing reached b or the database.
    const probe = edit(s, id); await synced(probe);
    expect(probe.text.length).toBe(start0);
    expect(b.text.length).toBe(start0);
    expect(Buffer.from((await stored(id)) ?? new Uint8Array()).equals(Buffer.from(seed))).toBe(true);
    expect(hits(s, 'state-size')).not.toHaveLength(0);
    expect(events(s, 'collab.refused').map((e) => e['code'])).toContain('state-cap');

    for (let i = 0; i < 20; i++) { b.text.insert(b.text.length, 'e'); await sleep(5); }
    await eventually(async () => ((await pageRow(DB, id))?.ydoc_size ?? 0) > STATE_CAP - 36_000 ? true : undefined, 8000, 'later edits stored');
    const row = await pageRow(DB, id);
    expect(row?.ydoc_size).toBeLessThanOrEqual(STATE_CAP);
    expect(textOf(row?.ydoc).endsWith('e'.repeat(20))).toBe(true);
    const c = edit(s, id); await synced(c);
    expect(c.text.length).toBe(start0 + 20);
    expect(c.text.toString()).not.toContain('v');
    expect([count(a, 'state-warning'), count(b, 'state-warning')]).toEqual([1, 1]);
    expect(events(s, 'collab.state_warning')).toHaveLength(1); // one per loaded page, however many editors
  }, 60_000);
});

describe('message rate (R4.18)', () => {
  it('400 messages in 10 seconds: rate-limited, the socket closes with 4429, the client reconnects and both clients end with all 400 characters; a second client is not disturbed', async () => {
    const s = await start(); const id = await page();
    const a = edit(s, id); const b = edit(s, id, 'dev:test-secret-0123456789abcdef:bob:member'); // the budget belongs to a user and page: the second client is another user
    await Promise.all([synced(a), synced(b)]);
    await sleep(6500); // past the 6 s reconnect-allowance window of a new connection
    for (let i = 0; i < 400; i++) a.text.insert(a.text.length, 'x');
    b.text.insert(0, 'B');
    await eventually(() => (a.closes.includes(4429) ? true : undefined), 8000, 'a closed with 4429');
    await eventually(() => (b.text.toString().length === 401 && a.text.toString() === b.text.toString() ? true : undefined), 30_000, 'a and b converge on 401 characters');
    expect(b.closes).not.toContain(4429);
    expect(b.text.toString().split('x')).toHaveLength(401);
    expect(count(a, 'rate-limited')).toBeGreaterThan(0);
    expect(hits(s, 'message-rate').length).toBeGreaterThan(0);
    expect(events(s, 'collab.refused').map((e) => e['code'])).toContain('rate-limited');
    const fresh = edit(s, id); await synced(fresh);
    expect(fresh.text.toString()).toBe(b.text.toString());
  }, 60_000);
});

describe('connections (R4.15, R4.45) and open documents (R4.49)', () => {
  it('the 101st connection to one page gets page-full and a new one is accepted after one disconnects', async () => {
    const s = await start(); const id = await page();
    const crowd = Array.from({ length: 100 }, (_, i) => edit(s, id, `dev:test-secret-0123456789abcdef:user${String(i)}:member`)); // one user each: the message budget is per user and page
    await Promise.all(crowd.map(synced));
    const extra = edit(s, id, 'dev:test-secret-0123456789abcdef:extra:member');
    await waitFailure(extra, 'page-full');
    expect(hits(s, 'page-connections')).toEqual([expect.objectContaining({ value: 100, max: 100 })]);
    crowd[0]?.text.insert(0, 'ok');
    await textIs(crowd[1] as Editor, 'ok');
    expect(extra.provider.synced).toBe(false);
    extra.destroy(); // a refused provider retries on its own: out of the way, so the freed slot goes to the new client
    crowd[99]?.destroy();
    // The server frees the slot when it handles the close: until then a new client is refused page-full, after that it syncs.
    const later = await eventually(async () => {
      const e = edit(s, id);
      const outcome = await eventually(() => (e.provider.synced ? 'synced' : e.failures.includes('page-full') ? 'full' : undefined), 8000, 'synced or page-full');
      if (outcome === 'synced') return e;
      e.destroy();
      return undefined;
    }, 10_000, 'a new connection accepted after one disconnects');
    expect(later.text.toString()).toBe('ok');
  }, 90_000);

  it('with GRIMOIRE_COLLAB_MAX_CONNECTIONS=5 the 6th connection gets server-full, wherever it is headed', async () => {
    const s = await start({ GRIMOIRE_COLLAB_MAX_CONNECTIONS: '5' });
    const ids = await Promise.all([page(), page(), page()]);
    const five = [ids[0], ids[0], ids[1], ids[1], ids[2]].map((p) => edit(s, p as string));
    await Promise.all(five.map(synced));
    const sixth = edit(s, ids[2] as string);
    await waitFailure(sixth, 'server-full');
    expect(hits(s, 'connections')).toEqual([expect.objectContaining({ value: 5, max: 5 })]);
    five[0]?.text.insert(0, 'a');
    await textIs(five[1] as Editor, 'a');
  }, 30_000);

  it('with GRIMOIRE_COLLAB_MAX_OPEN_DOCUMENTS=3 a connection to a 4th page gets documents-full, an open page still takes connections', async () => {
    const s = await start({ GRIMOIRE_COLLAB_MAX_OPEN_DOCUMENTS: '3' });
    const ids = await Promise.all([page(), page(), page(), page()]);
    const three = ids.slice(0, 3).map((p) => edit(s, p));
    await Promise.all(three.map(synced));
    const fourth = edit(s, ids[3] as string);
    await waitFailure(fourth, 'documents-full');
    const again = edit(s, ids[0] as string); await synced(again);
    expect(hits(s, 'open-documents')).toEqual([expect.objectContaining({ value: 3, max: 3 })]);
    expect(await stored(ids[3] as string)).toBeNull();
  }, 30_000);
});
