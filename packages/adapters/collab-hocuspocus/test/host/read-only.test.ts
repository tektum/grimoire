import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { PAGE } from './support.js';
import { connect, eventually, startLive } from './live-support.js';
import type { Client, Live } from './live-support.js';

// R4.11, R12.5: a read-authorised connection cannot change the document, the stored state or another user's view, whatever it sends.
// The viewer's provider socket is used as a raw client: frames are hand-built and sent anyway, bypassing the provider's own checks.
const lives: Live[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const l of lives.splice(0)) await l.stop();
});

const varUint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v > 127) { out.push(128 | (v & 127)); v = Math.floor(v / 128); }
  out.push(v);
  return out;
};
/** `[address][type][...body]` with a length-prefixed payload: the Hocuspocus frame layout. `address` is the provider's routing key. */
const frame = (address: string, head: number[], payload: Uint8Array): Uint8Array => {
  const name = new TextEncoder().encode(address);
  return Uint8Array.from([...varUint(name.length), ...name, ...head, ...varUint(payload.length), ...payload]);
};
const SYNC_UPDATE = [0, 2];
const SYNC_STEP2 = [0, 1];
const AWARENESS = [1];

/** A document update by a fresh Yjs client: real content the server would apply for a writer. */
function contentUpdate(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText('prosemirror').insert(0, text);
  return Y.encodeStateAsUpdate(d);
}
function awarenessAs(clientId: number, state: Record<string, unknown>): Uint8Array {
  const d = new Y.Doc(); d.clientID = clientId;
  const a = new Awareness(d);
  for (let i = 0; i < 50; i++) a.setLocalState({ ...state, n: i }); // a clock above anything the server holds for that id
  return encodeAwarenessUpdate(a, [clientId]);
}

async function live(): Promise<Live> {
  const l = await startLive(undefined, {}, (t) => {
    t.verifier.verify = (token: string) => Promise.resolve({ kind: 'ok', userId: token, expiresAt: 10_000_000 });
    void t.users.createIfAbsent({ descopeUserId: 'writer', email: 'w@example.test', name: 'w', role: 'member' });
    void t.users.createIfAbsent({ descopeUserId: 'viewer', email: 'v@example.test', name: 'v', role: 'viewer' });
  });
  const seed = new Y.Doc(); seed.getText('prosemirror').insert(0, 'original');
  l.t.pages.seed(PAGE, Y.encodeStateAsUpdate(seed));
  lives.push(l);
  return l;
}

describe('read-only is enforced by the server (raw frames from a viewer)', () => {
  it('updates, sync step 2 and impersonating presence change nothing: server document, stored row and the other client', async () => {
    const l = await live();
    const stateless: string[] = [];
    const writer = connect(l, PAGE, 'writer'); clients.push(writer);
    const viewer = connect(l, PAGE, 'viewer', { onStateless: (p) => { stateless.push(p); } }); clients.push(viewer);
    await eventually(() => writer.provider.synced && viewer.provider.synced, 5000, 'both synced');
    expect(viewer.provider.authorizedScope).toBe('readonly');
    expect(writer.provider.authorizedScope).toBe('read-write');
    const writerId = await l.t.idOf('writer');
    writer.provider.awareness?.setLocalState({ user: { name: 'W' } });
    await eventually(() => viewer.provider.awareness?.getStates().get(writer.document.clientID) !== undefined, 3000, 'viewer sees writer presence');
    const storesBefore = l.t.pages.calls.store;
    const rowBefore = l.t.pages.rows.get(PAGE);

    const send = (bytes: Uint8Array): void => { viewer.provider.configuration.websocketProvider.send(bytes); };
    send(frame(viewer.provider.effectiveName, SYNC_UPDATE, contentUpdate('VIEWER-UPDATE')));
    send(frame(viewer.provider.effectiveName, SYNC_STEP2, contentUpdate('VIEWER-STEP2')));
    // Presence for the writer's own client id, then the writer's user id on the viewer's own client id. Each is answered with a
    // presence-violation message (only the identity check sends it), so each frame is known to have been judged by that check.
    send(frame(viewer.provider.effectiveName, AWARENESS, awarenessAs(writer.document.clientID, { user: { id: writerId, name: 'EVIL' } })));
    await eventually(() => stateless.length >= 1, 3000, 'first impersonation refused, the viewer told');
    send(frame(viewer.provider.effectiveName, AWARENESS, awarenessAs(viewer.document.clientID, { user: { id: writerId, name: 'EVIL2' } })));
    await eventually(() => stateless.length >= 2, 3000, 'second impersonation refused, the viewer told');
    // Barrier: the viewer's own honest presence, handled after the frames above on the same connection, so once the writer sees it
    // anything those frames made the server send the writer has already arrived.
    viewer.provider.awareness?.setLocalState({ user: { name: 'V' }, marker: 1 });
    await eventually(() => writer.provider.awareness?.getStates().get(viewer.document.clientID)?.['marker'] === 1, 5000, 'writer sees the barrier');

    const serverDoc = l.host.hocuspocus?.documents.get(PAGE);
    expect(serverDoc?.getText('prosemirror').toString()).toBe('original');
    expect(writer.text.toString()).toBe('original');
    expect(JSON.stringify([...writer.provider.awareness?.getStates().values() ?? []])).not.toContain('EVIL');
    expect(l.host.hocuspocus?.documents.get(PAGE)?.awareness.getStates().get(writer.document.clientID)?.['user']).toEqual({ id: writerId, name: 'W' });
    // the viewer's presence carries the viewer's own row id, never the writer's
    expect(writer.provider.awareness?.getStates().get(viewer.document.clientID)?.['user']).toEqual({ id: await l.t.idOf('viewer'), name: 'V' });

    // The stored row: a writer edit is stored (proof the store path runs) and holds no viewer text.
    writer.text.insert(0, 'w:');
    await eventually(() => l.t.pages.calls.store > storesBefore, 15_000, 'writer edit stored');
    const stored = new Y.Doc(); Y.applyUpdate(stored, l.t.pages.rows.get(PAGE) ?? new Uint8Array());
    expect(stored.getText('prosemirror').toString()).toBe('w:original');
    expect(rowBefore).not.toBeNull();
    expect(l.t.pages.editors.get(PAGE)).not.toBe(await l.t.idOf('viewer'));
  }, 30_000);

  it('a viewer alone: its updates are never stored (the row and the store count stay as they were)', async () => {
    const l = await live();
    const viewer = connect(l, PAGE, 'viewer'); clients.push(viewer);
    await eventually(() => viewer.provider.synced, 5000, 'synced');
    const before = { stores: l.t.pages.calls.store, row: l.t.pages.rows.get(PAGE) };
    viewer.provider.configuration.websocketProvider.send(frame(viewer.provider.effectiveName, SYNC_UPDATE, contentUpdate('VIEWER')));
    viewer.text.insert(0, 'local only'); // the provider's own path too
    viewer.provider.awareness?.setLocalState({ marker: 1 });
    await eventually(() => l.host.hocuspocus?.documents.get(PAGE)?.awareness.getStates().get(viewer.document.clientID)?.['marker'] === 1, 5000, 'frames handled');
    expect(l.host.hocuspocus?.documents.get(PAGE)?.getText('prosemirror').toString()).toBe('original');
    viewer.destroy();
    await eventually(() => l.host.hocuspocus?.documents.size === 0, 10_000, 'document unloaded');
    expect(l.t.pages.calls.store).toBe(before.stores);
    expect(l.t.pages.rows.get(PAGE)).toBe(before.row);
  }, 20_000);
});
