import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createHandshakeExtension } from '../../src/handshake.js';

/** The belt called directly: the payloads are exactly what a provider sends as its sync step 2. */
function run(server: Y.Doc, payload: Uint8Array, ctx: Record<string, unknown> = { epoch: 2, epochUnknown: true }) {
  const sent: string[] = [];
  const data = { type: 1, payload, document: server, context: ctx, connection: { sendStateless: (m: string) => { sent.push(m); } } };
  return { sent, ctx, result: createHandshakeExtension().beforeSync?.(data as never) };
}
const pageWithDeletion = (): Y.Doc => {
  const d = new Y.Doc();
  const t = d.getText('prosemirror');
  t.insert(0, 'abc');
  t.delete(1, 1);
  return d;
};

describe('the first-sync belt', () => {
  it('lets a fresh client through that has applied a page with deleted text and offers the page\'s own delete set back', async () => {
    const server = pageWithDeletion();
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    const step2 = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(Y.diffUpdate(step2, Y.encodeStateVector(server)).byteLength).toBeGreaterThan(2); // the delete set is not the empty update
    const r = run(server, step2);
    await expect(r.result).resolves.toBeUndefined();
    expect(r.sent).toEqual([]);
  });

  it('refuses stale-epoch, tells the client, and applies nothing, when the update carries structs the page lacks', async () => {
    const server = pageWithDeletion();
    const old = new Y.Doc();
    old.getText('prosemirror').insert(0, 'old-edit');
    const r = run(server, Y.encodeStateAsUpdate(old, Y.encodeStateVector(server)));
    await expect(r.result).rejects.toMatchObject({ code: 4409, reason: 'stale-epoch' });
    expect(r.sent).toEqual([JSON.stringify({ grimoire: 1, kind: 'refusal', code: 'stale-epoch' })]);
    expect(server.getText('prosemirror').toString()).toBe('ac');
  });

  it('inspects only the first message, and nothing on a page at epoch 0 or for a client that knew its epoch', async () => {
    const old = new Y.Doc();
    old.getText('prosemirror').insert(0, 'old-edit');
    const payload = Y.encodeStateAsUpdate(old);
    const second = run(new Y.Doc(), payload, { epoch: 2 });
    await expect(second.result).resolves.toBeUndefined();
    const zero = run(new Y.Doc(), payload, { epoch: 0, epochUnknown: true });
    await expect(zero.result).resolves.toBeUndefined();
    expect(zero.ctx['epochUnknown']).toBe(false);
  });
});
