import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { messageSubtype, messageType, SESSION_CLOSE_CODES, statelessMessage } from '../../src/extensions/limits.js';
import { codeFor, REFUSAL_CLOSE_CODES } from '../../src/refusal.js';
import { frame, harness, pageName, updateOf } from './support.js';
import type { FakeConnection, Harness } from './support.js';

const A = pageName(1);
const B = pageName(2);
const sync = (h: Harness, doc: unknown, c: FakeConnection, type: number, payload: Uint8Array) =>
  h.ext.beforeSync?.({ type, payload, document: doc, connection: c.connection } as never);
const message = (h: Harness, doc: unknown, c: FakeConnection) =>
  h.ext.beforeHandleMessage?.({ update: frame(0), socketId: c.connection.socketId, documentName: A, document: doc, connection: c.connection } as never);

afterEach(() => { vi.useRealTimers(); });

describe('connections per page (R4.15)', () => {
  it('exactly at the limit is accepted, one over is page-full (4413), and a slot frees on disconnect', async () => {
    const h = harness({ maxConnectionsPerPage: 3 });
    await h.connect(A, 's1'); await h.connect(A, 's2');
    await expect(h.tryConnect(A)).resolves.toBeUndefined(); // the third
    await h.connect(A, 's3');
    await expect(h.tryConnect(A)).rejects.toMatchObject({ reason: 'page-full' });
    expect(codeFor(REFUSAL_CLOSE_CODES, 'page-full')).toBe(4413);
    expect(h.limitHits()).toEqual([{ limit: 'page-connections', value: 3, max: 3, pageId: A }]);
    await h.disconnect(A, 's1', 2);
    await expect(h.tryConnect(A)).resolves.toBeUndefined();
  });

  it('other pages are unaffected, and a repeated hook for one socket counts once', async () => {
    const h = harness({ maxConnectionsPerPage: 1 });
    await h.connect(A, 's1'); await h.connect(A, 's1');
    await expect(h.tryConnect(B)).resolves.toBeUndefined();
    await h.disconnect(A, 's1', 1); await h.disconnect(A, 's1', 1);
    await expect(h.tryConnect(A)).resolves.toBeUndefined();
  });
});

describe('connections per process (R4.45)', () => {
  it('the 6th with a cap of 5 gets server-full, checked before the page limit', async () => {
    const h = harness({ maxConnections: 5, maxConnectionsPerPage: 2 });
    for (let i = 0; i < 5; i++) await h.connect(pageName(10 + i), `s${String(i)}`);
    await expect(h.tryConnect(A)).rejects.toMatchObject({ reason: 'server-full' });
    expect(h.limitHits().at(-1)).toEqual({ limit: 'connections', value: 5, max: 5 });
    // The count is the process total only (the page limit of 2 did not block the first five, which sat on five pages), and it is checked again when a
    // socket is counted, so a sixth that passed the first check at the same moment as the others is refused too.
    await expect(h.connect(A, 'x1')).rejects.toMatchObject({ reason: 'server-full' });
    await h.disconnect(pageName(10), 's0', 0);
    await h.connect(A, 'x2'); // one place is free again
    await expect(h.tryConnect(A)).rejects.toMatchObject({ reason: 'server-full' }); // five again
  });
});

describe('open documents (R4.49)', () => {
  it('a 4th page with a cap of 3 gets documents-full; a page that is already open is still accepted', async () => {
    const h = harness({ maxOpenDocuments: 3 });
    for (const i of [1, 2, 3]) await h.connect(pageName(i), `s${String(i)}`);
    await expect(h.tryConnect(pageName(4))).rejects.toMatchObject({ reason: 'documents-full' });
    await expect(h.tryConnect(pageName(1))).resolves.toBeUndefined();
    h.documents.delete(pageName(3));
    await expect(h.tryConnect(pageName(4))).resolves.toBeUndefined();
    expect(h.limitHits()).toEqual([{ limit: 'open-documents', value: 3, max: 3 }]);
  });
});

describe('memory guard (R4.49)', () => {
  it('exactly 80% of the limit passes, one byte over refuses an unopened page and spares an open one', async () => {
    const h = harness({ memoryLimitBytes: 1000, memoryGuardPercent: 80 });
    await h.connect(A, 's1');
    h.memory = 800;
    await expect(h.tryConnect(B)).resolves.toBeUndefined();
    h.memory = 801;
    await expect(h.tryConnect(B)).rejects.toMatchObject({ reason: 'memory-guard' });
    await expect(h.tryConnect(A)).resolves.toBeUndefined();
    expect(h.limitHits()).toEqual([{ limit: 'memory', value: 801, max: 800 }]);
  });
});

describe('message rate (R4.18)', () => {
  it('300 messages pass, the 301st is rate-limited: stateless message, socket close 4429, other sockets unaffected', async () => {
    const h = harness({ messagesPerWindow: 300, rateWindowSeconds: 10 });
    const doc = h.doc(A);
    const flooder = h.conn('flood', doc); const calm = h.conn('calm', doc);
    for (let i = 0; i < 300; i++) await message(h, doc, flooder);
    expect(flooder.closes).toEqual([]);
    await expect(message(h, doc, flooder)).rejects.toMatchObject({ code: 4429, reason: 'rate-limited' });
    expect(flooder.closes).toEqual([{ code: 4429, reason: 'rate-limited' }]);
    expect(flooder.sent).toEqual([statelessMessage('refusal', 'rate-limited')]);
    await expect(message(h, doc, calm)).resolves.toBeUndefined();
    expect(calm.closes).toEqual([]);
    // the event is logged once per socket however many more frames arrive
    await expect(message(h, doc, flooder)).rejects.toMatchObject({ code: 4429 });
    expect(h.limitHits()).toEqual([{ limit: 'message-rate', value: 301, max: 300, pageId: A }]);
  });

  it('the count is per socket: documents on one socket share it, and a new socket starts again', async () => {
    const h = harness({ messagesPerWindow: 2, rateWindowSeconds: 60 });
    const c1 = h.conn('s', h.doc(A)); const c2 = h.conn('s', h.doc(B));
    await message(h, A, c1); await message(h, B, c2);
    await expect(message(h, A, c1)).rejects.toMatchObject({ code: 4429 });
    await expect(message(h, A, h.conn('s2', h.doc(A)))).resolves.toBeUndefined();
  });

  it('the counter of a closed socket is dropped', async () => {
    const h = harness({ messagesPerWindow: 1, rateWindowSeconds: 60 });
    await h.connect(A, 's'); const c = h.conn('s', h.doc(A));
    await message(h, A, c);
    await expect(message(h, A, c)).rejects.toBeDefined();
    await h.disconnect(A, 's', 0);
    await expect(message(h, A, c)).resolves.toBeUndefined();
  });
});

describe('malformed updates (R4.17)', () => {
  const garbage = Uint8Array.from({ length: 64 }, (_, i) => 255 - (i % 7));
  const valid = updateOf('hello');
  const truncated = valid.slice(0, valid.length - 3);

  it.each([['garbage', garbage], ['truncated', truncated]])('%s update: malformed-update, 4422, stateless message and collab.refused', async (_n, payload) => {
    const h = harness();
    const doc = h.doc(A); const c = h.conn('s', doc);
    await expect(sync(h, doc, c, 2, payload)).rejects.toMatchObject({ code: SESSION_CLOSE_CODES['malformed-update'], reason: 'malformed-update' });
    expect(c.sent).toEqual([statelessMessage('refusal', 'malformed-update')]);
    expect(h.logger.entries.filter((e) => e.event === 'collab.refused').map((e) => e.fields)).toEqual([{ code: 'malformed-update' }]);
    expect(doc.getText('prosemirror').toString()).toBe('');
  });

  it('a well-formed update, a state vector and an empty update pass; a state vector of garbage and an unknown sync type do not', async () => {
    const h = harness();
    const doc = h.doc(A); const c = h.conn('s', doc);
    await expect(sync(h, doc, c, 2, valid)).resolves.toBeUndefined();
    await expect(sync(h, doc, c, 1, Y.encodeStateAsUpdate(doc))).resolves.toBeUndefined();
    await expect(sync(h, doc, c, 0, Y.encodeStateVector(doc))).resolves.toBeUndefined();
    await expect(sync(h, doc, c, 2, Y.encodeStateAsUpdate(new Y.Doc()))).resolves.toBeUndefined();
    await expect(sync(h, doc, c, 0, garbage)).rejects.toMatchObject({ reason: 'malformed-update' });
    await expect(sync(h, doc, c, 9, valid)).rejects.toMatchObject({ reason: 'malformed-update' });
  });
});

describe('the caps hold when connections arrive at the same moment', () => {
  it('sockets that all passed onConnect before any was counted are refused when they are counted: the server cap and the page cap', async () => {
    const h = harness({ maxConnections: 2, maxConnectionsPerPage: 1 });
    const doc = h.doc(A);
    const a = h.conn('a', doc); const b = h.conn('b', doc);
    await h.open({ documentName: A, socketId: 'a', connection: a.connection });
    await expect(h.open({ documentName: A, socketId: 'b', connection: b.connection })).rejects.toMatchObject({ reason: 'page-full' });
    expect(b.closes).toEqual([]); // the refusal is the thrown reason; a socket with nothing else on it is closed by the peer registry
    const other = pageName(2); const doc2 = h.doc(other);
    const c = h.conn('c', doc2); const d = h.conn('d', h.doc(pageName(3)));
    await h.open({ documentName: other, socketId: 'c', connection: c.connection });
    await expect(h.open({ documentName: pageName(3), socketId: 'd', connection: d.connection })).rejects.toMatchObject({ reason: 'server-full' });
  });
});

describe('state cap and warning (R4.16, R4.47, R3.18)', () => {
  const pageOf = (n: number): Y.Doc => { const d = new Y.Doc(); d.getText('prosemirror').insert(0, 'x'.repeat(n)); return d; };
  const sizeAfterUpdate = (base: Y.Doc, u: Uint8Array): number => { const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(base)); Y.applyUpdate(d, u); return Y.encodeStateAsUpdate(d).byteLength; };
  const withState = (h: Harness, base: Y.Doc, connections: FakeConnection[] = []) => {
    const doc = h.doc(A, connections); Y.applyUpdate(doc, Y.encodeStateAsUpdate(base)); return doc;
  };

  it('review claim: many inserts that split an existing run, accepted one after another, never take the real state more than 12 bytes past the cap', async () => {
    const base = pageOf(2000);
    const cap = Y.encodeStateAsUpdate(base).byteLength + 60; // room for a few splits only
    const h = harness({ maxStateBytes: cap });
    const doc = withState(h, base); const c = h.conn('s', doc);
    const editor = new Y.Doc(); Y.applyUpdate(editor, Y.encodeStateAsUpdate(base));
    let last: Uint8Array = new Uint8Array(); editor.on('update', (x: Uint8Array) => { last = x; });
    let accepted = 0; let refused = 0;
    for (let i = 0; i < 200; i++) {
      editor.getText('prosemirror').insert(1 + ((i * 7) % 1500), 'ab'); // each insert lands inside an existing run and splits it
      try { await sync(h, doc, c, 2, last); Y.applyUpdate(doc, last); accepted++; } catch { refused++; Y.applyUpdate(doc, Y.encodeStateAsUpdate(new Y.Doc())); break; }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBe(1);
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThanOrEqual(cap + 12);
  });

  it('an update whose result is exactly the cap passes, one byte over is state-cap (4423): nothing is applied by the hook, the page stays editable', async () => {
    const base = pageOf(1000);
    const u = updateOf('y'.repeat(500), base);
    const result = sizeAfterUpdate(base, u);
    const pass = harness({ maxStateBytes: result });
    const c1 = pass.conn('s', null);
    await expect(sync(pass, withState(pass, base), c1, 2, u)).resolves.toBeUndefined();
    expect(c1.sent.filter((m) => m.includes('state-cap'))).toEqual([]);

    const refuse = harness({ maxStateBytes: result - 1 });
    const doc = withState(refuse, base); const c2 = refuse.conn('s', doc);
    const before = Y.encodeStateAsUpdate(doc);
    await expect(sync(refuse, doc, c2, 2, u)).rejects.toMatchObject({ code: 4423, reason: 'state-cap' });
    expect(c2.sent).toContain(statelessMessage('refusal', 'state-cap'));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(refuse.limitHits().at(-1)).toEqual({ limit: 'state-size', value: result, max: result - 1, pageId: A });
    // a one-character edit still fits: the page stays editable
    await expect(sync(refuse, doc, c2, 2, updateOf('z', base))).resolves.toBeUndefined();
  });

  it('a large update that deletes is not blocked at the cap: only the real result counts', async () => {
    const base = pageOf(5000);
    const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(base));
    const before = Y.encodeStateVector(d);
    d.getText('prosemirror').delete(0, 4990);
    const del = Y.encodeStateAsUpdate(d, before);
    const cap = Y.encodeStateAsUpdate(base).byteLength; // the page is exactly full
    const h = harness({ maxStateBytes: cap });
    const doc = withState(h, base); const c = h.conn('s', doc);
    await expect(sync(h, doc, c, 2, updateOf('q'.repeat(cap), base))).rejects.toMatchObject({ reason: 'state-cap' });
    await expect(sync(h, doc, c, 2, del)).resolves.toBeUndefined();
  });

  it('one state-warning to every editor when the state first passes the warning point (80% of the cap), none for later edits', async () => {
    const h = harness({ maxStateBytes: 10_000, stateWarnPercent: 80 });
    const c1 = h.conn('s1', null); const c2 = h.conn('s2', null);
    const doc = h.doc(A, [c1, c2]);
    await sync(h, doc, c1, 2, updateOf('a'.repeat(7000), doc)); // applied by hand below: the hook only looks
    expect(c1.sent).toEqual([]);
    Y.applyUpdate(doc, updateOf('a'.repeat(7000)));
    await sync(h, doc, c1, 2, updateOf('b'.repeat(1500), doc)); // 8,5xx > 8,000
    Y.applyUpdate(doc, updateOf('b'.repeat(1500), doc));
    for (let i = 0; i < 20; i++) await sync(h, doc, c1, 2, updateOf('c', doc));
    const warnings = (c: typeof c1) => c.sent.filter((m) => m === statelessMessage('warning', 'state-warning')).length;
    expect([warnings(c1), warnings(c2)]).toEqual([1, 1]);
    expect(h.logger.entries.filter((e) => e.event === 'collab.state_warning')).toHaveLength(1);
  });

  it('an editor joining a page already past the warning point gets one warning; one joining a small page gets none', async () => {
    const h = harness({ maxStateBytes: 10_000, stateWarnPercent: 80 });
    const big = withState(h, pageOf(8_100)); h.documents.set(A, big);
    const late = h.conn('late', big);
    await h.open({ documentName: A, socketId: 'late', connection: late.connection });
    const second = h.conn('late2', big);
    await h.open({ documentName: A, socketId: 'late2', connection: second.connection });
    expect([late.sent, second.sent]).toEqual([[statelessMessage('warning', 'state-warning')], [statelessMessage('warning', 'state-warning')]]);
    const small = h.doc(B); const quiet = h.conn('q', small);
    await h.open({ documentName: B, socketId: 'q', connection: quiet.connection });
    expect(quiet.sent).toEqual([]);
  });

  it('a read-only connection is validated but never counted against the cap', async () => {
    const base = pageOf(1000);
    const h = harness({ maxStateBytes: Y.encodeStateAsUpdate(base).byteLength });
    const doc = withState(h, base); const ro = h.conn('r', doc, true);
    await expect(sync(h, doc, ro, 2, updateOf('y'.repeat(500), base))).resolves.toBeUndefined();
    await expect(sync(h, doc, ro, 2, new Uint8Array([255, 255, 255, 255]))).rejects.toMatchObject({ reason: 'malformed-update' });
  });
});

describe('idle unload (R4.49)', () => {
  it('a page left loaded without connections is unloaded after the idle time, not before; a new connection cancels it', async () => {
    vi.useFakeTimers();
    const h = harness({ idleUnloadSeconds: 2 });
    await h.connect(A, 's1'); await h.connect(B, 's2');
    const docA = h.documents.get(A); const docB = h.documents.get(B);
    await h.disconnect(A, 's1', 0, docA); await h.disconnect(B, 's2', 0, docB);
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.unloaded).toEqual([]);
    await h.connect(B, 's3'); // B is in use again
    Object.assign(docB ?? {}, { getConnectionsCount: () => 1 });
    await vi.advanceTimersByTimeAsync(2);
    expect(h.unloaded).toEqual([docA]); // A: gone after 2 s; B: timer cleared on connect
    await h.ext.onDestroy?.({} as never);
  });
});

describe('message type from the frame header', () => {
  it('reads the type after the document name, for short and long names', () => {
    expect(messageType(frame(0))).toBe(0);
    expect(messageType(frame(1))).toBe(1);
    expect(messageType(frame(3))).toBe(3);
    const long = Uint8Array.from([200, 1, ...new Array<number>(200).fill(97), 5, 0]); // name length 200 takes two bytes
    expect(messageType(long)).toBe(5);
    expect(messageType(new Uint8Array())).toBeUndefined();
    expect(messageType(Uint8Array.from([5, 97]))).toBeUndefined();
  });
});

describe('two budgets: document messages and presence', () => {
  const awareness = (h: Harness, doc: unknown, c: FakeConnection, states = new Map<number, unknown>([[7, { x: 1 }]]), removed = new Set<number>([8])) =>
    h.ext.beforeHandleAwareness?.({ connection: c.connection, socketId: c.connection.socketId, documentName: A, document: doc, states, removedClients: removed } as never);

  it('a QueryAwareness frame (type 3) draws from the message budget: a stream of them closes the socket', async () => {
    const h = harness({ messagesPerWindow: 3, rateWindowSeconds: 60 });
    const doc = h.doc(A); const c = h.conn('s', doc);
    const query = (): Promise<void> | undefined => h.ext.beforeHandleMessage?.({ update: frame(3), socketId: 's', documentName: A, document: doc, connection: c.connection } as never);
    for (let i = 0; i < 3; i++) await query();
    await expect(query()).rejects.toMatchObject({ code: 4429 });
    expect(c.closes).toHaveLength(1);
  });

  it('presence frames never draw from the document budget and never close', async () => {
    const h = harness({ messagesPerWindow: 3, rateWindowSeconds: 60 });
    const doc = h.doc(A); const c = h.conn('s', doc);
    for (let i = 0; i < 1000; i++) await h.ext.beforeHandleMessage?.({ update: frame(1), socketId: 's', documentName: A, document: doc, connection: c.connection } as never);
    for (let i = 0; i < 3; i++) await message(h, doc, c);
    await expect(message(h, doc, c)).rejects.toMatchObject({ code: 4429 });
    expect(c.closes).toHaveLength(1);
  });

  const as = (h: Harness, doc: unknown, c: FakeConnection, userId: string) =>
    h.ext.beforeHandleMessage?.({ update: Uint8Array.from([1, 97, 0, 2]), socketId: c.connection.socketId, documentName: A, document: doc, connection: c.connection, context: { userId } } as never); // a sync UPDATE (type 0, subtype 2)

  it('a sync step 1 request never draws from the reconnect allowance: inside the 6 s it is held to the normal budget', async () => {
    const h = harness({ messagesPerWindow: 3, rateWindowSeconds: 60 });
    const doc = h.doc(A); const c = h.conn('s', doc);
    const step1 = () => h.ext.beforeHandleMessage?.({ update: Uint8Array.from([1, 97, 0, 0]), socketId: c.connection.socketId, documentName: A, document: doc, connection: c.connection, context: { userId: 'u' } } as never);
    for (let i = 0; i < 3; i++) await step1();
    await expect(step1()).rejects.toMatchObject({ code: 4429 });
  });

  it('the type and the subtype are read as the library reads them: a padded encoding does not hide a state request from the budget', async () => {
    expect(messageType(Uint8Array.from([1, 97, 0x83, 0x00, 0]))).toBe(3);
    expect(messageType(Uint8Array.from([1, 97, 0x80, 0x00, 0]))).toBe(0);
    expect(messageSubtype(Uint8Array.from([1, 97, 0x80, 0x00, 0x80, 0x00]))).toBe(0);
    const h = harness({ messagesPerWindow: 3, rateWindowSeconds: 60 });
    const doc = h.doc(A); const c = h.conn('s', doc);
    for (const crafted of [[1, 97, 0x80, 0x00, 0x80, 0x00], [1, 97, 0x83, 0x00]]) {
      const send = () => h.ext.beforeHandleMessage?.({ update: Uint8Array.from(crafted), socketId: c.connection.socketId, documentName: A, document: doc, connection: c.connection, context: { userId: `u${String(crafted.length)}` } } as never);
      for (let i = 0; i < 3; i++) await send();
      await expect(send()).rejects.toMatchObject({ code: 4429 });
    }
  });

  it('a reconnect backlog: the first 6 s of a connection draw from a separate allowance, then the budget applies', async () => {
    vi.useFakeTimers();
    const h = harness({ messagesPerWindow: 3, rateWindowSeconds: 60 });
    const doc = h.doc(A); const c = h.conn('s', doc);
    for (let i = 0; i < 500; i++) await as(h, doc, c, 'u');
    expect(c.closes).toEqual([]);
    for (let i = 0; i < 3; i++) await as(h, doc, c, 'u'); // still inside the 6 s
    await vi.advanceTimersByTimeAsync(6001);
    for (let i = 0; i < 3; i++) await as(h, doc, c, 'u');
    await expect(as(h, doc, c, 'u')).rejects.toMatchObject({ code: 4429 });
  });

  it('a QueryAwareness frame never draws from the reconnect allowance: inside the 6 s it is held to the normal budget', async () => {
    const h = harness({ messagesPerWindow: 3, rateWindowSeconds: 60 });
    const doc = h.doc(A); const c = h.conn('s', doc);
    const query = () => h.ext.beforeHandleMessage?.({ update: frame(3), socketId: c.connection.socketId, documentName: A, document: doc, connection: c.connection, context: { userId: 'u' } } as never);
    for (let i = 0; i < 3; i++) await query();
    await expect(query()).rejects.toMatchObject({ code: 4429 }); // the 4th, although the user has 5,000 allowance points left
  });

  it('the allowance is 5,000 messages: after that the budget applies even inside the 6 s', async () => {
    const h = harness({ messagesPerWindow: 3, rateWindowSeconds: 60 });
    const doc = h.doc(A); const c = h.conn('s', doc);
    for (let i = 0; i < 5003; i++) await as(h, doc, c, 'u');
    await expect(as(h, doc, c, 'u')).rejects.toMatchObject({ code: 4429 });
  });

  it('the allowance belongs to a user and page and refills 60 s after it was first drawn on: a reconnect does not renew it or the budget, another user is unaffected', async () => {
    vi.useFakeTimers();
    const h = harness({ messagesPerWindow: 3, rateWindowSeconds: 600 });
    const doc = h.doc(A);
    const first = h.conn('s1', doc);
    for (let i = 0; i < 5000; i++) await as(h, doc, first, 'u'); // the whole allowance
    await vi.advanceTimersByTimeAsync(6001);
    for (let i = 0; i < 3; i++) await as(h, doc, first, 'u'); // the budget of u on this page, used up too
    const second = h.conn('s2', doc);
    await vi.advanceTimersByTimeAsync(7000);
    await expect(as(h, doc, second, 'u')).rejects.toMatchObject({ code: 4429 });
    const other = h.conn('s3', doc);
    for (let i = 0; i < 100; i++) await as(h, doc, other, 'v'); // another user: own allowance
    expect(other.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(61_000);
    const third = h.conn('s4', doc);
    for (let i = 0; i < 100; i++) await as(h, doc, third, 'u'); // the allowance refilled
    expect(third.closes).toEqual([]);
  });

  it('3 presence updates per 100 ms pass, the rest are dropped (nothing relayed, nothing closed), one event per window, the newest is replayed after the window', async () => {
    vi.useFakeTimers();
    const h = harness();
    const doc = h.doc(A); const c = h.conn('s', doc);
    const outcomes: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      const frameI = Uint8Array.from([1, 97, 1, i]);
      await h.ext.beforeHandleMessage?.({ update: frameI, socketId: 's', documentName: A, document: doc, connection: c.connection } as never);
      const states = new Map<number, unknown>([[7, { x: i }]]); const removed = new Set<number>([8]);
      await awareness(h, doc, c, states, removed);
      outcomes.push(states.size === 1 && removed.size === 1);
    }
    expect(outcomes).toEqual([true, true, true, false, false, false, false, false, false, false]);
    expect(c.closes).toEqual([]);
    expect(h.limitHits()).toEqual([{ limit: 'presence-rate', value: 4, max: 3, pageId: A }]);
    expect(c.replayed).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(c.replayed).toEqual([Uint8Array.from([1, 97, 1, 9])]); // the last one, once
    await vi.advanceTimersByTimeAsync(500);
    expect(c.replayed).toHaveLength(1);
    await h.ext.onDestroy?.({} as never);
  });

  it('a presence update that passes cancels a held one; a held update for a closed connection is not replayed', async () => {
    vi.useFakeTimers();
    const h = harness();
    const doc = Object.assign(h.doc(A), { hasConnection: () => false }); const c = h.conn('s', doc);
    for (let i = 0; i < 5; i++) {
      await h.ext.beforeHandleMessage?.({ update: Uint8Array.from([1, 97, 1, i]), socketId: 's', documentName: A, document: doc, connection: c.connection } as never);
      await awareness(h, doc, c);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(c.replayed).toEqual([]);
    await h.ext.onDestroy?.({} as never);
  });
});
