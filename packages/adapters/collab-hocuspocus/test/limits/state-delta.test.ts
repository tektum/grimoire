import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// ESM namespaces cannot be spied on: the module is replaced by one whose two measured functions are pass-through spies.
vi.mock('yjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yjs')>();
  return { ...actual, encodeStateAsUpdate: vi.fn(actual.encodeStateAsUpdate), applyUpdate: vi.fn(actual.applyUpdate) };
});
import { harness, pageName, updateOf } from './support.js';
import type { FakeConnection, Harness } from './support.js';

const A = pageName(1);
afterEach(() => { vi.clearAllMocks(); });
const sync = (h: Harness, doc: unknown, c: FakeConnection, payload: Uint8Array) => h.ext.beforeSync?.({ type: 2, payload, document: doc, connection: c.connection } as never);
const pageOf = (n: number): Y.Doc => { const d = new Y.Doc(); d.getText('prosemirror').insert(0, 'p'.repeat(n)); return d; };
const withState = (h: Harness, base: Y.Doc) => { const doc = h.doc(A); Y.applyUpdate(doc, Y.encodeStateAsUpdate(base)); return doc; };

describe('near-cap check compares deltas', () => {
  it('encodes the document at most once per message, near the cap and past the warning point, and never clones it', async () => {
    const base = pageOf(1000);
    const u = updateOf('y'.repeat(500), base);
    const result = Y.mergeUpdates([Y.encodeStateAsUpdate(base), u]).byteLength;
    for (const [name, cap, warnPercent] of [['near the cap', result, 100], ['past the warning', result + 10_000, 1]] as const) {
      const h = harness({ maxStateBytes: cap, stateWarnPercent: warnPercent });
      const doc = withState(h, base); const c = h.conn('s', doc);
      await h.ext.connected?.({ documentName: A, socketId: 's', connection: c.connection } as never); // the document's size is recorded here, once per document
      const encode = vi.mocked(Y.encodeStateAsUpdate);
      const apply = vi.mocked(Y.applyUpdate);
      encode.mockClear(); apply.mockClear();
      await sync(h, doc, c, u);
      expect(encode.mock.calls.filter(([d]) => d === doc).length, name).toBeLessThanOrEqual(1);
      expect(apply, name).not.toHaveBeenCalled();
    }
  });

  it('property: the size from deltas is exact for inserts at the ends and never above, within a few bytes, when an insert splits a struct', () => {
    let seed = 11;
    const r = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor((seed / 2 ** 32) * n); };
    for (let round = 0; round < 80; round++) {
      const page = pageOf(1 + r(300));
      const state = Y.encodeStateAsUpdate(page);
      const editor = new Y.Doc(); Y.applyUpdate(editor, state);
      const text = editor.getText('prosemirror');
      const middle = r(2) === 0;
      text.insert(middle ? r(text.length + 1) : 0, 'e'.repeat(1 + r(200)));
      const update = Y.encodeStateAsUpdate(editor, Y.encodeStateVector(page));
      const estimate = Y.mergeUpdates([state, update]).byteLength;
      const actual = Y.encodeStateAsUpdate(editor).byteLength;
      expect(estimate).toBeLessThanOrEqual(actual);
      expect(actual - estimate).toBeLessThanOrEqual(middle ? 12 : 0);
    }
  });
});
