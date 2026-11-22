import { Buffer } from 'node:buffer';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appUrl, createTestDatabase, dropTestDatabase, requireBuild, startServer,
} from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { awarenessFrame, editor, RawClient, syncUpdateFrame } from './limits-support.js';
import type { Editor } from './limits-support.js';
import { eventually, newPage, pageRow, seedPage, sleep, textOf, wsUrl } from './support.js';

/**
 * The two budgets of the message limit, on the real built server with default settings: document messages (300 per 10 s per socket, closing
 * with 4429) and presence (about 30 a second per socket, dropped, never closing).
 */
const DB = 'grimoire_t10_rates';
const running: ServerProcess[] = [];
const editors: Editor[] = [];
const raws: RawClient[] = [];
const base = {
  GRIMOIRE_COLLAB_DEBOUNCE_MS: '300', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '1000',
  GRIMOIRE_COLLAB_CONNECT_ATTEMPTS_PER_WINDOW: '100000', GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS: '100000',
};
async function start(): Promise<ServerProcess> {
  const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), ...base } });
  running.push(s);
  return s;
}
const edit = (s: ServerProcess, page: string, token?: string): Editor => { const e = editor(wsUrl(s.port), page, token); editors.push(e); return e; };
const synced = (e: Editor): Promise<void> => eventually(() => (e.provider.synced ? true : undefined), 8000, 'synced').then(() => undefined);
const hits = (s: ServerProcess, limit: string) => s.events.filter((e) => e['event'] === 'collab.limit_hit' && e['limit'] === limit);
const page = async (): Promise<string> => { const id = newPage(); await seedPage(DB, id); return id; };

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterEach(async () => {
  editors.splice(0).forEach((e) => { e.destroy(); });
  raws.splice(0).forEach((r) => { r.close(); });
  await Promise.all(running.splice(0).map((s) => s.kill()));
});
afterAll(async () => { await dropTestDatabase(DB); });

/** The cursor of the other client as this client sees it. */
const cursorOf = (viewer: Editor, other: Editor): unknown => {
  const states = viewer.provider.awareness?.getStates();
  return states?.get(other.provider.document.clientID)?.['cursor'];
};
const everyMs = async (ms: number, count: number, fn: (i: number) => void): Promise<void> => {
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    fn(i);
    const wait = t0 + (i + 1) * ms - performance.now();
    if (wait > 0) await sleep(wait);
  }
};

describe('ordinary use is never limited', () => {
  it('60 seconds of typing at 15 characters a second with cursor movement: no close, no drop, no limit event, everything stored', async () => {
    const s = await start(); const id = await page();
    const a = edit(s, id); const b = edit(s, id);
    await Promise.all([synced(a), synced(b)]);
    const chars = 900;
    await everyMs(1000 / 15, chars, (i) => { a.text.insert(a.text.length, 'k'); a.provider.setAwarenessField('cursor', { at: i }); });
    await eventually(() => (b.text.length === chars ? true : undefined), 5000, 'b has every character');
    await eventually(async () => (textOf((await pageRow(DB, id))?.ydoc) === 'k'.repeat(chars) ? true : undefined), 20_000, 'everything stored');
    expect([a.closes, b.closes]).toEqual([[], []]);
    expect(s.events.filter((e) => e['event'] === 'collab.limit_hit')).toEqual([]);
    expect(cursorOf(b, a)).toEqual({ at: chars - 1 });
  }, 120_000);

  it('a 20-second mouse drag at 60 presence updates a second: no close, and the other client ends at the final position within 200 ms', async () => {
    const s = await start(); const id = await page();
    const a = edit(s, id); const b = edit(s, id);
    await Promise.all([synced(a), synced(b)]);
    const updates = 1200;
    await everyMs(1000 / 60, updates, (i) => { a.provider.setAwarenessField('cursor', { x: i }); });
    const t = performance.now();
    await eventually(() => (JSON.stringify(cursorOf(b, a)) === JSON.stringify({ x: updates - 1 }) ? true : undefined), 200, 'final cursor position within 200 ms');
    expect(performance.now() - t).toBeLessThan(200);
    expect([a.closes, b.closes]).toEqual([[], []]);
    expect(hits(s, 'message-rate')).toEqual([]);
    expect(hits(s, 'presence-rate').length).toBeGreaterThan(0); // 60 a second is over the budget: the excess was dropped
  }, 60_000);
});

describe('floods are stopped', () => {
  it('1,000 document updates in 2 seconds from a raw client, once the user\'s reconnect allowance is used up: rate-limited, closed with 4429, a second client on the page is unaffected', async () => {
    const s = await start(); const id = await page();
    const b = edit(s, id, 'dev:test-secret-0123456789abcdef:bob:member'); await synced(b);
    // The first connection of a user and page may send up to 5,000 messages (the reconnect allowance, see limits.ts): use it up.
    const first = await RawClient.open(wsUrl(s.port), id); raws.push(first);
    const burst = (n: number): Uint8Array<ArrayBuffer>[] => {
      const local = new Y.Doc(); const out: Uint8Array<ArrayBuffer>[] = [];
      local.on('update', (u: Uint8Array) => { out.push(syncUpdateFrame(id, u)); });
      for (let i = 0; i < n; i++) local.getText('prosemirror').insert(i, 'f');
      return out;
    };
    for (const f of burst(6000)) { if (first.closed) break; first.send(f); }
    await eventually(() => first.closed, 10_000, 'first flooder closed');
    // A second connection of the same user within the cooldown: only the normal budget, and the first one already used it.
    const flood = await RawClient.open(wsUrl(s.port), id); raws.push(flood);
    for (const f of burst(1000)) { if (flood.closed) break; flood.send(f); await sleep(2); }
    await eventually(() => flood.closed, 5000, 'flooder closed');
    expect(flood.closed?.code).toBe(4429);
    expect(flood.stateless.some((m) => m.includes('rate-limited'))).toBe(true);
    await eventually(() => (hits(s, 'message-rate').length >= 1 ? true : undefined), 3000, 'rate event logged');
    b.text.insert(b.text.length, 'still works');
    await eventually(async () => (textOf((await pageRow(DB, id))?.ydoc).endsWith('still works') ? true : undefined), 20_000, 'b still saves');
    expect(b.closes).toEqual([]);
  }, 90_000);

  it('10,000 presence updates in 2 seconds: dropped beyond the budget, not relayed, and the flooder is not closed', async () => {
    const s = await start(); const id = await page();
    const b = edit(s, id); await synced(b);
    let relayed = 0;
    const flood = await RawClient.open(wsUrl(s.port), id); raws.push(flood);
    const awareness = new Awareness(new Y.Doc());
    const seen = new Set<number>([b.provider.document.clientID]);
    b.provider.awareness?.on('update', ({ added, updated }: { added: number[]; updated: number[] }) => {
      for (const c of [...added, ...updated]) if (!seen.has(c)) relayed++;
    });
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) {
      flood.send(awarenessFrame(id, awareness, { cursor: { i } }));
      if (i % 50 === 49) await sleep(Math.max(0, ((i + 1) / 10_000) * 2000 - (performance.now() - t0)));
    }
    // The server holds the newest dropped update and replays it when the window ends: once b sees the last one, every frame was handled.
    await eventually(() => (JSON.stringify(b.provider.awareness?.getStates().get(awareness.clientID)?.['cursor']) === JSON.stringify({ i: 9_999 }) ? true : undefined), 5000, 'the last presence update relayed');
    expect(flood.closed).toBeUndefined();
    expect(hits(s, 'message-rate')).toEqual([]);
    expect(hits(s, 'presence-rate').length).toBeGreaterThan(0);
    expect(hits(s, 'presence-rate').length).toBeLessThanOrEqual(2); // one event per window, not one per dropped update
    expect(relayed).toBeGreaterThan(0);
    expect(relayed).toBeLessThan(400); // about 30 a second for 2.5 s, against 10,000 sent
    expect(Buffer.from(JSON.stringify(b.provider.awareness?.getStates().get(awareness.clientID) ?? {})).length).toBeGreaterThan(2);
  }, 60_000);
});

describe('reconnecting with a backlog (Hocuspocus provider queues every edit made offline and sends them all at once on reconnect)', () => {
  it.each([500, 5000])('a client that edited %i times offline reconnects without a refusal and both clients converge', async (n) => {
    const s = await start(); const id = await page();
    const a = edit(s, id); const b = edit(s, id);
    await Promise.all([synced(a), synced(b)]);
    const ws = a.provider.configuration.websocketProvider;
    ws.disconnect();
    await eventually(() => (a.closes.length > 0 ? true : undefined), 5000, 'a offline');
    const closesBefore = a.closes.length;
    for (let i = 0; i < n; i++) a.text.insert(a.text.length, 'q');
    await ws.connect();
    await eventually(() => (b.text.length === n ? true : undefined), 30_000, `b receives ${String(n)} edits`);
    await eventually(async () => (textOf((await pageRow(DB, id))?.ydoc) === 'q'.repeat(n) ? true : undefined), 15_000, 'stored');
    expect(a.closes.slice(closesBefore)).toEqual([]); // no close after the reconnect
    expect(a.closes.every((c) => c !== 4429 && c !== 4205)).toBe(true);
    expect(hits(s, 'message-rate')).toEqual([]);
    expect(s.events.filter((e) => e['event'] === 'collab.refused')).toEqual([]);
  }, 90_000);
});
