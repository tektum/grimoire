import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { createPresenceExtension } from '../src/extensions/presence.js';
import { pageName } from './limits/support.js';

/** The decoded awareness states a client with `clientId` would publish, as `beforeHandleAwareness` receives them. */
function published(clientId: number, user: string, name: string): Awareness {
  const doc = Object.assign(new Y.Doc(), { clientID: clientId });
  const sender = new Awareness(doc);
  sender.setLocalState({ user: { id: user, name } });
  const received = new Awareness(new Y.Doc());
  received.states.delete(received.clientID);
  applyAwarenessUpdate(received, encodeAwarenessUpdate(sender, [clientId]), null);
  return received;
}

function setup() {
  const source = new Y.Doc();
  source.getText('prosemirror').insert(0, 'edited');
  const document = Object.assign(new Y.Doc(), { name: pageName(1) });
  const ext = createPresenceExtension();
  const told: Record<string, string[]> = { editor: [], reader: [] };
  const peer = (socketId: string) => ({ socketId, readOnly: socketId === 'reader', sendStateless: (m: string) => { told[socketId]?.push(m); } });
  const connections = { editor: peer('editor'), reader: peer('reader') };
  const awareness = async (who: 'editor' | 'reader', user: string, states: Awareness) => {
    await ext.beforeHandleAwareness?.({ document, states: states.states, removedClients: new Set(), socketId: who, connection: connections[who], context: { userId: user } } as never);
  };
  const firstUpdate = () => ext.beforeSync?.({ type: 2, payload: Y.encodeStateAsUpdate(source), document, connection: connections.editor, socketId: 'editor', context: { userId: 'editor' } } as never);
  return { source, ext, told, document, awareness, firstUpdate };
}

describe('presence client id and untrusted names', () => {
  it('a reader that publishes the editor client id first does not block the editor, and the squat is void once the editor writes', async () => {
    const t = setup();
    const markup = '<img src=x onerror=alert(1)>';
    const squat = published(t.source.clientID, 'reader', 'squatter');
    await t.awareness('reader', 'reader', squat);
    expect(squat.states.get(t.source.clientID)).toBeDefined(); // before any proof the claim stands: nothing is blocked up front
    await t.firstUpdate();
    const genuine = published(t.source.clientID, 'editor', markup);
    await t.awareness('editor', 'editor', genuine);
    expect(t.told['editor']).toEqual([]);
    expect(genuine.states.get(t.source.clientID)).toMatchObject({ user: { id: 'editor', name: markup } }); // markup passes through unchanged
    const again = published(t.source.clientID, 'reader', 'squatter');
    await t.awareness('reader', 'reader', again);
    expect(again.states.has(t.source.clientID)).toBe(false); // the reader no longer publishes the editor's id
    expect(t.told['reader']).toHaveLength(1);
  });

  it('the first update binds the client id of the socket, a read-only socket never binds, and a later foreign client id is dropped', async () => {
    const t = setup();
    await t.firstUpdate();
    const other = new Y.Doc();
    const foreign = published(other.clientID, 'editor', 'x');
    await t.awareness('editor', 'editor', foreign);
    expect(foreign.states.has(other.clientID)).toBe(false);
    expect(t.told['editor']).toHaveLength(1);
  });

  it('the proof outlives the editor removing its own presence: a reader still cannot claim the id afterwards', async () => {
    const t = setup();
    await t.firstUpdate();
    await t.awareness('editor', 'editor', published(t.source.clientID, 'editor', 'e'));
    await t.ext.beforeHandleAwareness?.({ document: t.document, states: new Map(), removedClients: new Set([t.source.clientID]), socketId: 'editor', connection: { socketId: 'editor', sendStateless: () => undefined }, context: { userId: 'editor' } } as never);
    const claim = published(t.source.clientID, 'reader', 'squatter');
    await t.awareness('reader', 'reader', claim);
    expect(claim.states.has(t.source.clientID)).toBe(false);
  });
});
