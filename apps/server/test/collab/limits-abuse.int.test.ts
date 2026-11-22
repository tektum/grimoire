import { readFileSync } from 'node:fs';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appUrl, createTestDatabase, dropTestDatabase, requireBuild, startServer,
} from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { awarenessFrame, editor, RawClient, syncUpdateFrame } from './limits-support.js';
import type { Editor } from './limits-support.js';
import { waitUntil } from '@tektum/grimoire-test-support/harness';
import { eventually, newPage, seedPage, sleep, wsUrl } from './support.js';

/** What an unauthenticated or authenticated attacker can get through, on the real built server with default settings. */
const DB = 'grimoire_t10_abuse';
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
const edit = (s: ServerProcess, page: string, token: string): Editor => { const e = editor(wsUrl(s.port), page, token); editors.push(e); return e; };
const synced = (e: Editor): Promise<void> => eventually(() => (e.provider.synced ? true : undefined), 8000, 'synced').then(() => undefined);
/** Waits until the text of a client stops changing for a second (relaying thousands of updates takes a while). */
const settled = async (e: Editor): Promise<void> => {
  let last = -1; let since = Date.now(); const giveUpAt = Date.now() + 30_000; // a hard maximum: a text that keeps changing fails here, not at the test timeout
  while (Date.now() - since < 1000) {
    if (Date.now() > giveUpAt) throw new Error('the text did not settle within 30 s');
    await sleep(100); if (e.text.length !== last) { last = e.text.length; since = Date.now(); }
  }
};
/**
 * Runs `step` at once and then every `periodMs` until `durationMs` have passed, one step at a time; resolves after the last step. This is a scenario's
 * schedule on the real clock of the child server (a typist, an attacker reconnecting every few seconds), not a wait for an outcome.
 */
function onSchedule(periodMs: number, durationMs: number, step: () => void | Promise<void>): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const t0 = Date.now();
  let chain = Promise.resolve();
  const tick = (): void => {
    if (Date.now() - t0 >= durationMs) { clearInterval(timer); chain.then(resolve, reject); return; }
    chain = chain.then(step);
  };
  const timer = setInterval(tick, periodMs);
  tick();
  return promise;
}
const rss = (s: ServerProcess): number => Number(readFileSync(`/proc/${String(s.child.pid)}/statm`, 'utf8').split(' ')[1]) * 4096;
const page = async (): Promise<string> => { const id = newPage(); await seedPage(DB, id); return id; };
const openRaw = async (s: ServerProcess, id: string, token: string): Promise<RawClient> => { const r = await RawClient.open(wsUrl(s.port), id, token); raws.push(r); return r; };
/** `count` single-character updates, each from its own Yjs client so that a dropped one never blocks the next. */
const updates = (id: string, count: number): Uint8Array<ArrayBuffer>[] => Array.from({ length: count }, () => {
  const d = new Y.Doc(); let u = new Uint8Array(); d.on('update', (x: Uint8Array) => { u = x; });
  d.getText('prosemirror').insert(0, 'a');
  return syncUpdateFrame(id, u);
});

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterEach(async () => {
  editors.splice(0).forEach((e) => { e.destroy(); });
  raws.splice(0).forEach((r) => { r.close(); });
  await Promise.all(running.splice(0).map((s) => s.kill()));
});
afterAll(async () => { await dropTestDatabase(DB); });

describe('unauthenticated sockets', () => {
  it('2,000 frames of 64 KB from a socket that never authenticates: the socket is closed after about 1 MiB and the server grows by less than 64 MiB', async () => {
    const s = await start(); const id = await page();
    const before = rss(s);
    const r = await RawClient.openUnauthenticated(wsUrl(s.port)); raws.push(r);
    const frame = syncUpdateFrame(id, new Uint8Array(65_536));
    let sent = 0;
    // 5 ms (not seconds) after every 20 frames: lets the socket drain so the flood arrives as a stream the server's budget sees frame by frame, not as one burst.
    for (; sent < 2000 && !r.closed; sent++) { r.send(frame); if (sent % 20 === 19) await sleep(5); }
    await eventually(() => r.closed, 5000, 'unauthenticated socket closed');
    expect(sent).toBeLessThan(2000);
    // The growth stays under 64 MiB while the server digests what it received (half a second, sampled; a breach ends the wait at once).
    expect(await waitUntil(() => rss(s) - before >= 64 * 1024 * 1024, 500)).toBe(false);
    expect(rss(s) - before).toBeLessThan(64 * 1024 * 1024);
  }, 60_000);
});

describe('the reconnect allowance cannot be farmed', () => {
  it('a flood starting immediately after authentication: at most 5,000 (allowance) plus the 300 budget get through, then 4429', async () => {
    const s = await start(); const id = await page();
    const b = edit(s, id, 'dev:test-secret-0123456789abcdef:bob:member'); await synced(b);
    const flood = await openRaw(s, id, 'dev:test-secret-0123456789abcdef:mallory:member');
    const frames = updates(id, 6000);
    for (const f of frames) { if (flood.closed) break; flood.send(f); }
    await eventually(() => flood.closed, 10_000, 'flooder closed');
    expect(flood.closed?.code).toBe(4429);
    // What this proves: the limiter engaged and closed the flooder with `rate-limited` (above), the reconnect allowance was really granted (more than
    // the plain 300 budget reached the other client: waited for, not timed), and nothing beyond allowance + budget got through. How many of the
    // allowed frames the other client has received by a given time depends on machine load, so no absolute count is asserted.
    await eventually(() => (b.text.length > 300 ? true : undefined), 30_000, 'more than the plain budget arrived');
    await settled(b);
    expect(b.text.length).toBeGreaterThan(300);
    expect(b.text.length).toBeLessThanOrEqual(5000 + 300 + 50);
    expect(b.closes).toEqual([]);
  }, 60_000);

  it('an attacker reconnecting every 3 seconds for 60 seconds gets at most 5,000 + 300 per 10 s through and is closed on the rest; another user is unaffected', async () => {
    const s = await start(); const id = await page();
    const bob = edit(s, id, 'dev:test-secret-0123456789abcdef:bob:member'); await synced(bob);
    let closed4429 = 0; let bobChars = 0;
    const typing = onSchedule(500, 60_000, () => { bob.text.insert(bob.text.length, 'b'); bobChars++; });
    // One attacker connection per 3 s slot until second 57: each floods, and is looked at (closed with 4429 or not) when its slot ends.
    const attackers: RawClient[] = [];
    const tally = (r: RawClient | undefined): void => { if (r?.closed?.code === 4429) closed4429++; r?.close(); };
    await onSchedule(3000, 57_000, async () => {
      tally(attackers.at(-1));
      const r = await openRaw(s, id, 'dev:test-secret-0123456789abcdef:mallory:member'); attackers.push(r);
      for (const f of updates(id, 2000)) { if (r.closed) break; r.send(f); }
    });
    tally(attackers.at(-1));
    await typing;
    await settled(bob);
    // What counts is the server's copy, read by a second editor that joins after the flood (Bob's own document has all his characters at once, whatever the server did).
    const reader = edit(s, id, 'dev:test-secret-0123456789abcdef:carol:member'); await synced(reader);
    const count = (ch: string): number => [...reader.text.toString()].filter((c) => c === ch).length;
    await eventually(() => (count('b') === bobChars ? true : undefined), 15_000, 'every character Bob typed is in the server\'s copy');
    const through = count('a'); // what the attacker got through ('a' is all the attacker sends)
    expect(through).toBeGreaterThanOrEqual(5000);
    expect(through).toBeLessThanOrEqual(5000 + 300 * 7 + 100); // the allowance once, then the normal budget of 300 per 10 s window
    expect(closed4429).toBeGreaterThan(0);
    expect(bob.closes).toEqual([]);
    expect(reader.text.length).toBe(through + bobChars); // and nothing else is in the text
  }, 120_000);
});

describe('presence replay goes through the presence checks', () => {
  const states = (viewer: Editor, seen: unknown[]): void => {
    viewer.provider.awareness?.on('update', () => { for (const st of viewer.provider.awareness?.getStates().values() ?? []) seen.push(JSON.stringify(st)); });
  };

  it('a forged state that is dropped by the budget and replayed is refused by the ownership check: nobody sees it and the sender is told', async () => {
    const s = await start(); const id = await page();
    const bob = edit(s, id, 'dev:test-secret-0123456789abcdef:bob:member'); await synced(bob);
    const seen: unknown[] = []; states(bob, seen);
    const mallory = await openRaw(s, id, 'dev:test-secret-0123456789abcdef:mallory:member');
    const aw = new Awareness(new Y.Doc());
    for (let i = 0; i < 30; i++) mallory.send(awarenessFrame(id, aw, { cursor: i }));
    mallory.send(awarenessFrame(id, aw, { cursor: 99, user: { id: 'someone-else' } })); // over budget: held, then replayed
    await eventually(() => (mallory.stateless.some((m) => m.includes('presence-violation')) ? true : undefined), 3000, 'sender told');
    expect(await waitUntil(() => seen.some((x) => String(x).includes('someone-else') || String(x).includes('"cursor":99')), 300)).toBe(false);
    expect(seen.some((x) => String(x).includes('someone-else'))).toBe(false);
    expect(seen.some((x) => String(x).includes('"cursor":99'))).toBe(false);
  }, 30_000);

  it('a held update for a socket that has since closed is discarded: no presence comes back for the departed user', async () => {
    const s = await start(); const id = await page();
    const bob = edit(s, id, 'dev:test-secret-0123456789abcdef:bob:member'); await synced(bob);
    const mallory = await openRaw(s, id, 'dev:test-secret-0123456789abcdef:mallory:member');
    const aw = new Awareness(new Y.Doc());
    for (let i = 0; i < 30; i++) mallory.send(awarenessFrame(id, aw, { cursor: i }));
    await eventually(() => (bob.provider.awareness?.getStates().has(aw.clientID) ? true : undefined), 5000, 'bob saw mallory\'s presence first'); // so its going away below is a removal, not an absence from the start
    mallory.close();
    await eventually(() => mallory.closed, 3000, 'closed');
    // The departed user's presence goes, and the held update does not bring it back (it would be replayed within the next presence window).
    await eventually(() => (bob.provider.awareness?.getStates().has(aw.clientID) === false ? true : undefined), 800, 'departed presence removed');
    expect(await waitUntil(() => bob.provider.awareness?.getStates().has(aw.clientID) === true, 800)).toBe(false);
    expect(bob.provider.awareness?.getStates().has(aw.clientID)).toBe(false);
  }, 30_000);
});
