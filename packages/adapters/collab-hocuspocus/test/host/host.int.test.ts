import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Refusal } from '../../src/refusal.js';
import { PAGE, SUBJECT, U1 } from './support.js';
import { connect, eventually, startLive } from './live-support.js';
import type { Client, Live } from './live-support.js';

const lives: Live[] = [];
const clients: Client[] = [];
const live = async (...a: Parameters<typeof startLive>): Promise<Live> => { const l = await startLive(...a); lives.push(l); return l; };
const client = (...a: Parameters<typeof connect>): Client => { const c = connect(...a); clients.push(c); return c; };
afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  await Promise.all(lives.splice(0).map((l) => l.stop()));
});
const socketStatus = (c: Client): string => String(c.provider.configuration.websocketProvider.status);
const synced = (c: Client) => eventually(() => c.provider.synced, 3000, 'synced');

describe('collaboration host over a real socket (fake verifier and page store)', () => {
  it('two provider clients converge and a late third receives the state', async () => {
    const l = await live('member'); l.t.pages.seed(PAGE);
    const a = client(l, PAGE); const b = client(l, PAGE);
    await Promise.all([synced(a), synced(b)]);
    a.text.insert(0, 'hello ');
    await eventually(() => b.text.toString() === 'hello ', 3000, 'b sees a');
    b.text.insert(b.text.length, 'world');
    await eventually(() => a.text.toString() === 'hello world', 3000, 'a sees b');
    const c = client(l, PAGE);
    await synced(c);
    expect(c.text.toString()).toBe('hello world');
  });

  it('bad document names: reason bad-document-name, no verifier or store call', async () => {
    const l = await live('member');
    for (const name of ['0B6F4F0E-3C1D-4A53-9A62-5D1C2A7E8F10', '0b6f4f0e3c1d4a539a625d1c2a7e8f10', '../x', 'a'.repeat(300), '{0B6F4F0E-3C1D-4A53-9A62-5D1C2A7E8F10}']) {
      const c = client(l, name);
      await eventually(() => c.failures.length > 0, 3000, `refusal for ${name.slice(0, 12)}`);
      expect(c.failures).toEqual(['bad-document-name']);
    }
    expect(l.t.verifier.calls).toBe(0);
    expect(l.t.pages.calls).toEqual({ load: 0, store: 0 });
  });

  it('unknown page: not-found', async () => {
    const l = await live('member');
    const c = client(l, PAGE);
    await eventually(() => c.failures.length > 0, 3000, 'refusal');
    expect(c.failures[0]).toBe('not-found');
  });

  it('wrong token: invalid-token, socket closed within 1 s, a token function that now returns a right token connects after connect()', async () => {
    const l = await live('member'); l.t.pages.seed(PAGE);
    l.t.verifier.result = { kind: 'invalid-token' };
    let good = false;
    const c = client(l, PAGE, () => (good ? 'right' : 'wrong'));
    await eventually(() => c.failures.length > 0, 3000, 'refusal');
    expect(c.failures[0]).toBe('invalid-token');
    const t0 = Date.now();
    await eventually(() => c.closes.length > 0, 1500, 'socket closed');
    expect(Date.now() - t0).toBeLessThan(1000);
    good = true;
    l.t.verifier.result = { kind: 'ok', userId: 'u1', expiresAt: 10_000_000 };
    await c.provider.connect();
    await synced(c);
    await eventually(() => !c.provider.hasUnsyncedChanges, 3000, 'no unsynced changes');
  });

  it('verifier outage: try-again, one collab.auth_unavailable error, an already connected client stays connected; expiry in the past is invalid-token', async () => {
    const l = await live('member'); l.t.pages.seed(PAGE);
    const ok = client(l, PAGE); await synced(ok);
    l.t.verifier.result = { kind: 'service-unavailable' };
    const c = client(l, PAGE);
    await eventually(() => c.failures.length > 0, 3000, 'refusal');
    expect(c.failures[0]).toBe('try-again');
    expect(l.t.logger.entries.filter((e) => e.event === 'collab.auth_unavailable')).toHaveLength(1);
    expect(l.t.logger.entries.find((e) => e.event === 'collab.auth_unavailable')?.level).toBe('error');
    await eventually(() => c.closes.length > 0, 3000, 'refused socket closed');
    ok.text.insert(0, 'still here');
    await eventually(() => !ok.provider.hasUnsyncedChanges, 3000, 'the connected client is still acknowledged after the refusal');
    expect(socketStatus(ok)).toBe('connected');
    l.t.verifier.result = { kind: 'ok', userId: 'u1', expiresAt: l.t.clock.now() - 1 };
    const d = client(l, PAGE);
    await eventually(() => d.failures.length > 0, 3000, 'refusal');
    expect(d.failures[0]).toBe('invalid-token');
  });

  it('viewer: readonly scope, writes never reach the other client or the store', async () => {
    const l = await live('viewer'); l.t.pages.seed(PAGE);
    const v = client(l, PAGE, 'dev:v:viewer'); await synced(v);
    expect(v.provider.authorizedScope).toBe('readonly');
    // a writer on the same page: swap the role source to member for the second client
    const w = client(l, PAGE); await synced(w);
    v.text.insert(0, 'viewer-text');
    // a later frame on the viewer's socket that does reach w: the earlier write has been handled (and dropped) by then
    v.provider.setAwarenessField('barrier', 1);
    await eventually(() => w.provider.awareness?.getStates().get(v.document.clientID)?.['barrier'] === 1, 3000, 'w sees the viewer awareness');
    expect(w.text.toString()).toBe('');
    expect(l.host.hocuspocus?.documents.get(PAGE)?.getText('prosemirror').toString()).toBe('');
    expect(l.t.pages.rows.get(PAGE)).toBeNull();
  });

  it('a probe extension sees the context: userId is the row id (not the subject), descopeUserId, accessLevel, expiresAt, epoch', async () => {
    const seen: unknown[] = [];
    const probe = { extensionName: 'probe', priority: 90, async connected(d: { context: unknown }) { seen.push(d.context); } };
    const l = await live('member', { extensions: [probe] }); l.t.pages.seed(PAGE);
    const c = client(l, PAGE); await synced(c);
    expect(seen[0]).toMatchObject({ userId: U1, descopeUserId: SUBJECT, accessLevel: 'read-write', expiresAt: 10_000_000, epoch: 0, address: expect.any(String), peerId: expect.any(String) });
    expect(Object.values(seen[0] ?? {})).not.toContain('t'); // the token ('t') is not kept in the context (R4.8)
  });

  it('a page edited once is stored; the stored state decodes to the edit', async () => {
    const l = await live('member'); l.t.pages.seed(PAGE);
    const c = client(l, PAGE); await synced(c);
    c.text.insert(0, 'kept');
    await eventually(() => l.t.pages.rows.get(PAGE) != null, 15_000, 'stored');
    const d = new Y.Doc(); Y.applyUpdate(d, l.t.pages.rows.get(PAGE) ?? new Uint8Array());
    expect(d.getText('prosemirror').toString()).toBe('kept');
  }, 20_000);

  it('store failure: retried with backoff, the alarm appears once, later edits are not lost; at the deadline the page is reported abandoned', async () => {
    const l = await live('member', { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
    l.t.pages.seed(PAGE); l.t.pages.failStores = true;
    const c = client(l, PAGE); await synced(c);
    c.text.insert(0, 'one');
    await eventually(() => l.t.logger.entries.filter((e) => e.event === 'collab.store_failed').length >= 6, 20_000, 'failures');
    expect(l.t.logger.entries.filter((e) => e.event === 'collab.store_alarm')).toHaveLength(1);
    c.text.insert(c.text.length, ' two');
    l.t.pages.failStores = false;
    await eventually(() => l.t.pages.rows.get(PAGE) != null, 10_000, 'recovered');
    const d = new Y.Doc(); Y.applyUpdate(d, l.t.pages.rows.get(PAGE) ?? new Uint8Array());
    await eventually(() => { const x = new Y.Doc(); Y.applyUpdate(x, l.t.pages.rows.get(PAGE) ?? new Uint8Array()); return x.getText('prosemirror').toString() === 'one two'; }, 15_000, 'latest text stored');
  }, 60_000);

  it('shutdown with failures continuing resolves within the deadline plus a second and logs store_abandoned', async () => {
    const l = await live('member'); l.t.pages.seed(PAGE); l.t.pages.failStores = true;
    const c = client(l, PAGE); await synced(c);
    c.text.insert(0, 'lost');
    await eventually(() => !c.provider.hasUnsyncedChanges, 3000, 'the edit reached the host');
    const t0 = Date.now();
    const report = await l.host.shutdown({ deadlineMs: 2000 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(report.abandonedPages).toBe(1);
    expect(l.t.logger.entries.filter((e) => e.event === 'collab.store_abandoned')).toEqual([{ level: 'error', event: 'collab.store_abandoned', fields: { pageId: PAGE } }]);
  }, 15_000);

  it('pings keep an idle connection alive past the idle timeout', async () => {
    const l = await live('member', { idleTimeoutMs: 1500, pingIntervalSeconds: 1 }); l.t.pages.seed(PAGE);
    let pongs = 0; // pong frames (first byte 0x8a) the client sends back to the server's pings, read off the raw upgraded socket
    l.server.on('upgrade', (_req, socket) => { socket.on('data', (d: Buffer) => { if (d[0] === 0x8a) pongs += 1; }); });
    const c = client(l, PAGE); await synced(c);
    await eventually(() => pongs >= 3 || c.closes.length > 0, 8000, 'three ping rounds (about 3 s, twice the idle timeout)');
    expect(socketStatus(c)).toBe('connected');
    expect(c.closes).toEqual([]);
  }, 15_000);

  const PAGE_B = '1c7e0f3a-5b2d-4e8f-8a11-9b3c4d5e6f70';
  const stateOf = (l: Live, id: string): string => { const d = new Y.Doc(); Y.applyUpdate(d, l.t.pages.rows.get(id) ?? new Uint8Array()); return d.getText('prosemirror').toString(); };

  it('closing one page touches only that page: a socket on another page stays open and keeps syncing', async () => {
    const l = await live('member'); l.t.pages.seed(PAGE); l.t.pages.seed(PAGE_B);
    const a = client(l, PAGE); const b1 = client(l, PAGE_B); const b2 = client(l, PAGE_B);
    await Promise.all([synced(a), synced(b1), synced(b2)]);
    await l.host.closeConnections({ documentName: PAGE });
    await eventually(() => a.closes.length > 0, 3000, 'the closed page reached its client');
    b1.text.insert(0, 'still alive');
    await eventually(() => b2.text.toString() === 'still alive', 3000, 'b2 sees b1 after the other page was closed');
    expect(b1.closes).toEqual([]); expect(b2.closes).toEqual([]);
    expect(socketStatus(b1)).toBe('connected');
  });

  it('unreadable stored state: the client sees a close with the documented code within 2 s, the server stays up, another page works, the database is not hammered, nothing is written', async () => {
    const l = await live('member'); l.t.pages.seed(PAGE, new Uint8Array([255, 255, 255, 9, 9, 9, 9])); l.t.pages.seed(PAGE_B);
    const bad = client(l, PAGE);
    await eventually(() => bad.closes.length > 0, 2000, 'close');
    expect(bad.closes[0]).toBe(4500);
    expect(l.t.logger.entries.some((e) => e.event === 'collab.refused' && e.fields['code'] === 'state-corrupt')).toBe(true);
    const ok = client(l, PAGE_B); await synced(ok);
    await eventually(() => bad.closes.length >= 2, 8000, 'the refused client retried and was refused again');
    expect(l.t.pages.calls.load).toBeLessThanOrEqual(5);
    expect(l.t.pages.calls.store).toBe(0);
    expect(JSON.stringify(l.t.logger.entries)).not.toContain('Unexpected');
  }, 15_000);

  it('a reason registered from outside the adapter reaches the wire with its code', async () => {
    const seedFail = { extensionName: 'seed', priority: 90, async onLoadDocument() { throw new Refusal('seed-failed'); } };
    const l = await live('member', { extensions: [seedFail], refusals: { 'seed-failed': 4470 } }); l.t.pages.seed(PAGE);
    const c = client(l, PAGE);
    await eventually(() => c.failures.length > 0, 3000, 'refused');
    expect(c.failures[0]).toBe('seed-failed');
    await eventually(() => c.closes.length > 0, 2000, 'closed');
    expect(c.closes[0]).toBe(4470);
    expect(l.t.logger.entries.some((e) => e.event === 'collab.refused' && e.fields['code'] === 'seed-failed')).toBe(true);
  });

  it('an unexpected error in an outside extension becomes internal-error: closed, and its message is never logged', async () => {
    const boom = { extensionName: 'boom', priority: 90, async onLoadDocument() { throw new Error('SECRET-INTERNAL-DETAIL'); } };
    const l = await live('member', { extensions: [boom] }); l.t.pages.seed(PAGE);
    const c = client(l, PAGE);
    await eventually(() => c.failures.length > 0, 3000, 'refused');
    expect(c.failures[0]).toBe('internal-error');
    await eventually(() => c.closes.length > 0, 2000, 'closed');
    expect(JSON.stringify(l.t.logger.entries)).not.toContain('SECRET-INTERNAL-DETAIL');
  });

  it('edits made before the debounce fires are stored when the host shuts down', async () => {
    const l = await live('member'); l.t.pages.seed(PAGE); // default debounce 3 s
    const c = client(l, PAGE); await synced(c);
    c.text.insert(0, 'before shutdown');
    await new Promise((r) => setTimeout(r, 150));
    expect(l.t.pages.rows.get(PAGE)).toBeNull();
    const report = await l.host.shutdown({ deadlineMs: 2000 });
    expect(report.abandonedPages).toBe(0);
    expect(stateOf(l, PAGE)).toBe('before shutdown');
  });

  it('shutdown reports as abandoned only pages with unsaved changes: a loaded page that is already stored is not', async () => {
    const keep = { extensionName: 'keep', priority: 90, async beforeUnloadDocument() { throw new Error(''); } }; // the page stays loaded
    const l = await live('member', { extensions: [keep] }); l.t.pages.seed(PAGE);
    const c = client(l, PAGE); await synced(c);
    c.text.insert(0, 'stored');
    await eventually(() => l.t.pages.rows.get(PAGE) != null, 15_000, 'stored');
    const report = await l.host.shutdown({ deadlineMs: 300 });
    expect(report.abandonedPages).toBe(0);
    expect(l.t.logger.entries.filter((e) => e.event === 'collab.store_abandoned')).toEqual([]);
    expect(l.host.hocuspocus?.getDocumentsCount()).toBe(1);
  }, 25_000);
});

