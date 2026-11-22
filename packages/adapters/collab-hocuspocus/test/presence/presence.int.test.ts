import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOWED_ORIGIN, originSocket } from '@tektum/grimoire-test-support';
import { eventually, startLive } from '../host/live-support.js';
import type { Live } from '../host/live-support.js';
import { AWARENESS_STATE_MAX_BYTES } from '../../src/extensions/presence.js';
import { PAGE } from '../host/support.js';

const lives: Live[] = [];
const clients: HocuspocusProvider[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const l of lives.splice(0)) await l.stop();
});

/**
 * Each token is its own subject, so three clients are three users; the local-mode provisioner creates their rows. Presence carries
 * the row id (`users.id`), never the subject (R4.12, contracts section 2): `idOf` looks it up.
 */
async function live(): Promise<Live> {
  const l = await startLive('member', {}, (t) => {
    t.verifier.verify = (token: string) => Promise.resolve({ kind: 'ok', userId: token, expiresAt: 10_000_000 });
    t.provisionAs('member');
  });
  l.t.pages.seed(PAGE);
  lives.push(l);
  return l;
}

interface Peer { readonly provider: HocuspocusProvider; readonly stateless: string[]; readonly id: number }
async function join(l: Live, user: string): Promise<Peer> {
  const stateless: string[] = [];
  const provider = new HocuspocusProvider({
    url: l.url, name: PAGE, token: user, document: new Y.Doc(), WebSocketPolyfill: originSocket(ALLOWED_ORIGIN),
    onStateless: ({ payload }) => { stateless.push(payload); },
  });
  clients.push(provider);
  await eventually(() => provider.synced, 5000, `${user} synced`);
  return { provider, stateless, id: provider.document.clientID };
}

const varUint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v > 127) { out.push(128 | (v & 127)); v = Math.floor(v / 128); }
  out.push(v);
  return out;
};
/** A hand-built Hocuspocus awareness frame (document name, message type 1, update), sent on the sender's own socket. */
function sendRaw(p: Peer, update: Uint8Array): void {
  const name = new TextEncoder().encode(PAGE);
  const frame = Uint8Array.from([...varUint(name.length), ...name, 1, ...varUint(update.length), ...update]);
  p.provider.configuration.websocketProvider.send(frame);
}
/** An awareness update as if produced by Yjs client `id` with `state` (null = removal). */
function forged(id: number, state: Record<string, unknown> | null): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = id;
  const aw = new Awareness(doc);
  aw.setLocalState({ placeholder: true });
  aw.setLocalState(state);
  return encodeAwarenessUpdate(aw, [id]);
}
const seen = (observer: Peer, id: number): Record<string, unknown> | undefined => observer.provider.awareness?.getStates().get(id);
/**
 * A doc edit from `from` that `to` must see (for one peer: that the host acknowledges). The host handles a socket's frames in order and
 * writes to `to`'s socket in order, so once it lands, every earlier frame of `from` was handled and whatever that sent `to` has arrived.
 */
async function barrier(from: Peer, to: Peer): Promise<void> {
  const text = from.provider.document.getText('barrier');
  text.insert(text.length, 'x');
  const want = text.toString();
  await eventually(() => (from === to ? !from.provider.hasUnsyncedChanges : to.provider.document.getText('barrier').toString() === want), 3000, 'barrier');
}

describe('presence identity (R4.12)', () => {
  it('a state without user.id is shown with the authenticated user id; name and colour pass through', async () => {
    const l = await live();
    const a = await join(l, 'alice');
    const b = await join(l, 'bob');
    a.provider.awareness?.setLocalState({ user: { name: 'Ada', color: '#f00' }, cursor: { anchor: 1 } });
    await eventually(() => seen(b, a.id) !== undefined, 3000, 'b sees a');
    const alice = await l.t.idOf('alice');
    expect(alice).not.toBe('alice');
    expect(seen(b, a.id)).toEqual({ user: { id: alice, name: 'Ada', color: '#f00' }, cursor: { anchor: 1 } });
  });

  it('a forged client id, a forged removal, a mixed frame and a wrong user.id are dropped; the sender is told', async () => {
    const l = await live();
    const a = await join(l, 'alice');
    const b = await join(l, 'bob');
    const c = await join(l, 'carol');
    a.provider.awareness?.setLocalState({ user: { name: 'Ada' } });
    c.provider.awareness?.setLocalState({ user: { name: 'Cy' } });
    await eventually(() => seen(b, a.id) !== undefined && seen(b, c.id) !== undefined, 3000, 'b sees a and c');
    const alice = await l.t.idOf('alice');
    const carol = await l.t.idOf('carol');

    // forged client id: carol publishes a state for alice's id
    sendRaw(c, forged(a.id, { user: { id: alice, name: 'EVIL' } }));
    await eventually(() => c.stateless.length === 1, 3000, 'violation 1');
    // forged removal of alice's state
    sendRaw(c, forged(a.id, null));
    await eventually(() => c.stateless.length === 2, 3000, 'violation 2');
    // mixed frame: carol's own state plus alice's
    const mixedDoc = new Y.Doc();
    mixedDoc.clientID = c.id;
    const mixed = new Awareness(mixedDoc);
    for (let i = 0; i < 20; i += 1) mixed.setLocalState({ user: { name: 'Cy2' } }); // the clock must beat the one the server holds
    applyAwarenessUpdate(mixed, forged(a.id, { user: { name: 'EVIL2' } }), 'x');
    sendRaw(c, encodeAwarenessUpdate(mixed, [c.id, a.id]));
    await eventually(() => c.stateless.length === 3, 3000, 'violation 3');
    // wrong user.id on carol's own client id
    sendRaw(c, forged(c.id, { user: { id: alice, name: 'Cy3' } }));
    await eventually(() => c.stateless.length === 4, 3000, 'violation 4');
    // a second client id from the same connection
    sendRaw(c, forged(c.id + 1, { user: { name: 'ghost' } }));
    await eventually(() => c.stateless.length === 5, 3000, 'violation 5');
    await barrier(c, b);

    expect(c.stateless.every((m) => m === JSON.stringify({ grimoire: 1, kind: 'refusal', code: 'presence-violation' }))).toBe(true);
    expect(seen(b, a.id)).toEqual({ user: { id: alice, name: 'Ada' } }); // untouched, never EVIL
    expect(seen(b, c.id)).toEqual({ user: { id: carol, name: 'Cy2' } }); // the own part of the mixed frame went through
    expect(seen(b, c.id + 1)).toBeUndefined();
    expect(JSON.stringify([...b.provider.awareness?.getStates().values() ?? []])).not.toContain('EVIL');
  });

  it('an over-cap awareness state (4 KiB) never reaches the other client and the sender is told; honest states of 300 to 530 bytes always do', async () => {
    const l = await live();
    const a = await join(l, 'alice');
    const b = await join(l, 'bob');
    sendRaw(a, forged(a.id, { user: { name: 'x'.repeat(900_000) } }));
    await eventually(() => a.stateless.length === 1, 3000, 'violation for 900 KB');
    sendRaw(a, forged(a.id, { user: { name: 'y'.repeat(AWARENESS_STATE_MAX_BYTES) } }));
    await eventually(() => a.stateless.length === 2, 3000, 'violation for over-cap');
    await barrier(a, b);
    expect(b.provider.awareness?.getStates().has(a.id)).toBe(false);
    a.provider.awareness?.setLocalState({ user: { name: 'n'.repeat(200), color: '#ff0000' }, cursor: { anchor: { type: { client: 3141592653, clock: 123456 }, tname: null, item: { client: 3141592653, clock: 123456 }, assoc: 0 }, head: null } });
    await eventually(() => seen(b, a.id) !== undefined, 3000, 'honest state arrives');
    expect(JSON.stringify([...b.provider.awareness?.getStates().values() ?? []])).not.toContain('xxxxxxxx');
  });

  it('disconnecting a client removes its client id for the other client', async () => {
    const l = await live();
    const a = await join(l, 'alice');
    const b = await join(l, 'bob');
    a.provider.awareness?.setLocalState({ user: { name: 'Ada' } });
    await eventually(() => seen(b, a.id) !== undefined, 3000, 'b sees a');
    a.provider.destroy();
    await eventually(() => seen(b, a.id) === undefined, 5000, 'a removed');
  });

  it('a client id released by a disconnect can be published by another connection', async () => {
    const l = await live();
    const a = await join(l, 'alice');
    const b = await join(l, 'bob');
    a.provider.awareness?.setLocalState({ user: { name: 'Ada' } });
    await eventually(() => seen(b, a.id) !== undefined, 3000, 'b sees a');
    a.provider.destroy();
    await eventually(() => seen(b, a.id) === undefined, 5000, 'a removed');
    sendRaw(b, forged(a.id, { user: { name: 'reused' } }));
    await barrier(b, b);
    // bob owns his own id already (first published or none yet): either way the foreign id is never shown as alice
    expect(seen(b, a.id)?.['user']).not.toEqual({ id: await l.t.idOf('alice'), name: 'reused' });
  });
});
