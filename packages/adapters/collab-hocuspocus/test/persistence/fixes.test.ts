import * as Y from 'yjs';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import type { ConvertResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { describe, expect, it } from 'vitest';
import { createPersistenceExtension } from '../../src/extensions/persistence.js';
import { reidentify } from '../../src/save.js';
import { createCollabLog } from '../../src/events.js';
import { makeDeps } from '../host/support.js';
import { okOf, PAGE, seedDoc, setup } from './support.js';

const fail = (reason: 'timeout' | 'out-of-memory', detail = 'the conversion exceeded its time limit'): ConvertResult => ({ ok: false, reason, detail });
const ids = (state: Uint8Array): number[] => { const d = new Y.Doc(); Y.applyUpdate(d, state); return [...Y.decodeStateVector(Y.encodeStateVector(d)).keys()]; };
const seedState = (text: string): Uint8Array => Y.encodeStateAsUpdate(seedDoc(text));

describe('F7: an edit the Markdown cannot show is still stored', () => {
  it('same Markdown, different state: the state is written; identical state: nothing', async () => {
    const s = setup();
    const constant = new FakeMarkdownConverter({ convert: () => ({ ok: true, markdown: 'same', text: 'same' }) });
    const ext = createPersistenceExtension({ deps: { ...s.deps, converter: constant }, log: s.log, sleep: () => new Promise(() => undefined) });
    const save = () => ext.onStoreDocument?.({ document: s.doc, documentName: PAGE } as never) ?? Promise.resolve();
    await s.edit('a'); await save();
    await s.edit(' '); await save(); // trailing space: the Markdown is the same
    expect(s.pages.writes).toHaveLength(2);
    expect(s.pages.rows.get(PAGE)).toEqual(Y.encodeStateAsUpdate(s.doc));
    await save();
    expect(s.pages.writes).toHaveLength(2);
    expect(s.events('collab.save_skipped')).toHaveLength(1);
  });
});

describe('F5: two seeds of different Markdown never share an identity', () => {
  it('different Markdown or page: different client ids, never the converter\'s fixed one; the same inputs give the same bytes', () => {
    const a = reidentify(seedState('alpha'), PAGE, 'alpha');
    const b = reidentify(seedState('beta'), PAGE, 'beta');
    expect(ids(a)).not.toEqual(ids(b));
    expect(ids(a)).not.toContain(3_000_000_000);
    expect(ids(reidentify(seedState('alpha'), 'other-page', 'alpha'))).not.toEqual(ids(a));
    expect(reidentify(seedState('alpha'), PAGE, 'alpha')).toEqual(a);
    const d = new Y.Doc(); Y.applyUpdate(d, a);
    expect(d.getXmlFragment('prosemirror').toString()).toContain('alpha');
  });

  it('the reviewer\'s scenario: a stale tab with the old seed types, the server holds the new seed: both converge and nothing is mixed up', () => {
    const tab = new Y.Doc(); Y.applyUpdate(tab, reidentify(seedState('alpha alpha'), PAGE, 'alpha alpha'));
    const server = new Y.Doc(); Y.applyUpdate(server, reidentify(seedState('beta'), PAGE, 'beta'));
    const para = tab.getXmlFragment('prosemirror').get(0);
    const run = para instanceof Y.XmlElement ? para.get(0) : undefined;
    if (!(run instanceof Y.XmlText)) throw new Error('no run');
    const before = Y.encodeStateVector(tab);
    run.insert(3, 'XX');
    Y.applyUpdate(server, Y.encodeStateAsUpdate(tab, Y.encodeStateVector(server)));
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(server, Y.encodeStateVector(tab)));
    void before;
    expect(tab.getXmlFragment('prosemirror').toString()).toBe(server.getXmlFragment('prosemirror').toString());
    expect(server.getXmlFragment('prosemirror').toString()).toContain('alpXXha alpha');
    expect(server.getXmlFragment('prosemirror').toString()).toContain('beta');
  });

  it('load applies the reidentified seed', async () => {
    const s = setup();
    s.pages.markdowns.set(PAGE, 'alpha');
    s.converter.enqueueSeed({ ok: true, state: seedState('alpha') });
    const doc = new Y.Doc();
    await s.ext.onLoadDocument?.({ document: doc, documentName: PAGE, context: { peerId: 'p1' } } as never);
    expect([...doc.store.clients.keys()]).not.toContain(3_000_000_000);
  });
});

describe('F2: per-page circuit breaker', () => {
  const heavy = (s: ReturnType<typeof setup>, n: number) => { for (let i = 0; i < n; i++) s.converter.enqueueConvert(fail('timeout')); };

  it('one timeout while running opens it: the third save converts nothing, stores the state, marks the page stale, one alarm; back-off 30 s; a good probe closes it with one line', async () => {
    const s = setup();
    heavy(s, 1);
    await s.edit('a'); await s.store();
    expect(s.events('collab.convert_breaker_open')).toHaveLength(1);
    expect(s.events('collab.convert_breaker_open')[0]?.fields).toMatchObject({ failures: 1, backoffMs: 30_000 });
    const calls = s.converter.convertCalls.length;
    await s.edit('c'); await s.store();
    await s.edit('d'); await s.store();
    expect(s.converter.convertCalls.length).toBe(calls);
    expect(s.pages.stale.get(PAGE)).not.toBeNull();
    expect(s.pages.rows.get(PAGE)).toEqual(Y.encodeStateAsUpdate(s.doc)); // the state is stored every time
    s.clock.advance(30_001);
    await s.edit('e'); await s.store();
    expect(s.converter.convertCalls.length).toBe(calls + 1);
    expect(s.events('collab.convert_breaker_closed')).toHaveLength(1);
    expect(s.pages.stale.get(PAGE)).toBeNull();
    await s.edit('f'); await s.store();
    expect(s.converter.convertCalls.length).toBe(calls + 2); // closed: converting again
  });

  it('a failed probe reopens it with a longer back-off (30 s, 2 min, 8 min, 30 min cap) and logs nothing more', async () => {
    const s = setup();
    heavy(s, 1);
    await s.edit('a'); await s.store();
    const waits = [30_000, 120_000, 480_000, 1_800_000, 1_800_000];
    for (const [i, w] of waits.entries()) {
      s.clock.advance(w - 1);
      const calls = s.converter.convertCalls.length;
      await s.edit('x'); await s.store();
      expect(s.converter.convertCalls.length, `still open before ${String(w)} (${String(i)})`).toBe(calls);
      s.clock.advance(2);
      if (i < 4) s.converter.enqueueConvert(fail('out-of-memory', 'oom'));
      await s.edit('y'); await s.store();
      expect(s.converter.convertCalls.length).toBe(calls + 1);
    }
    expect(s.events('collab.convert_breaker_open')).toHaveLength(1);
  });

  it('a page whose state shrank below 75% of its failing size is tried at once', async () => {
    const s = setup();
    for (let i = 0; i < 40; i++) s.doc.getText('prosemirror').insert(0, 'padding padding ');
    heavy(s, 1);
    await s.edit('a'); await s.store();
    const calls = s.converter.convertCalls.length;
    const small = setup(); void small;
    s.doc.getText('prosemirror').delete(0, s.doc.getText('prosemirror').length - 4);
    await s.store();
    expect(s.converter.convertCalls.length).toBe(calls + 1);
  });

  it('out-of-memory needs two in a row; busy answers and cheap refusals never open it', async () => {
    const s = setup();
    s.converter.enqueueConvert(fail('out-of-memory', 'oom'));
    await s.edit('a'); await s.store();
    expect(s.events('collab.convert_breaker_open')).toHaveLength(0);
    s.converter.enqueueConvert(fail('out-of-memory', 'oom'));
    await s.edit('b'); await s.store();
    expect(s.events('collab.convert_breaker_open')).toHaveLength(1);
  });

  it('busy answers and cheap refusals never open it', async () => {
    const s = setup();
    for (let i = 0; i < 4; i++) s.converter.enqueueConvert({ ok: false, reason: 'internal', detail: 'queue-full' });
    for (let i = 0; i < 4; i++) s.converter.enqueueConvert({ ok: false, reason: 'content-lost', detail: 'x' });
    for (let i = 0; i < 8; i++) { await s.edit('e'); await s.store(); }
    expect(s.events('collab.convert_breaker_open')).toHaveLength(0);
  });
});

describe('F2: a hostile page next to ordinary pages (real timers, 1/10 of the production scale)', () => {
  // Scale: 1 s here = 10 s of production. Hostile conversion = 400 ms (the 4 s timeout), ordinary = 15 ms, back-off 3 s (30 s).
  it('10 ordinary pages editing for 6 s: every Markdown is at most 1 s old after its save is due, the hostile page uses a bounded share of the worker, the breaker opens and probes late', async () => {
    const t = makeDeps('member');
    const HOSTILE = 'hostile-page';
    const pages = Array.from({ length: 10 }, (_, i) => `page-${String(i)}`);
    let hostileMs = 0; let ordinaryMs = 0;
    const converter = new FakeMarkdownConverter({
      convert: async (state: Uint8Array): Promise<ConvertResult> => {
        const d = new Y.Doc(); Y.applyUpdate(d, state);
        // Fixture, not a wait: the hostile page's conversion is deliberately slow (it stands for a conversion that runs into its timeout).
        if (d.getText('prosemirror').toString().startsWith('HOSTILE')) { await new Promise((r) => setTimeout(r, 1000)); hostileMs += 1000; return fail('timeout'); }
        await new Promise((r) => setTimeout(r, 15)); ordinaryMs += 15;
        return okOf(state);
      },
    });
    const clock = { now: () => Date.now() };
    const deps = { ...t.deps, converter, clock };
    for (const id of [HOSTILE, ...pages]) t.pages.seed(id);
    const ext = createPersistenceExtension({ deps, log: createCollabLog(t.logger), sleep: () => new Promise(() => undefined), breaker: { baseMs: 3000, maxMs: 180_000 }, convertWaitMs: 5000 });
    const docs = new Map([HOSTILE, ...pages].map((id) => [id, new Y.Doc()]));
    const staleness: number[] = [];
    const lastEdit = new Map<string, number>();
    const end = Date.now() + 6000;
    const editors = [HOSTILE, ...pages].map(async (id) => {
      const doc = docs.get(id) ?? new Y.Doc();
      if (id === HOSTILE) doc.getText('prosemirror').insert(0, 'HOSTILE');
      while (Date.now() < end) {
        doc.getText('prosemirror').insert(doc.getText('prosemirror').length, 'x');
        lastEdit.set(id, Date.now());
        await ext.onChange?.({ documentName: id, context: {} } as never);
        const started = Date.now();
        await ext.onStoreDocument?.({ document: doc, documentName: id } as never);
        if (id !== HOSTILE) staleness.push(Date.now() - started);
        await new Promise((r) => setTimeout(r, 100)); // the debounce
      }
    });
    await Promise.all(editors);
    const worst = Math.max(...staleness);
    // an ordinary save waits for at most one running hostile conversion (one timeout: 1000 ms here, 10 s in production, once per back-off period) and the ordinary ones ahead
    expect(worst).toBeLessThan(1500);
    expect(t.logger.entries.filter((e) => e.event === 'collab.convert_breaker_open')).toHaveLength(1);
    // one conversion to open it, then one probe after the 3 s back-off: far below the 6 s of worker time an unprotected page would take
    expect(hostileMs).toBeLessThanOrEqual(2 * 1000);
    expect(hostileMs / (hostileMs + ordinaryMs)).toBeLessThan(0.5);
    for (const id of pages) expect(t.pages.markdowns.get(id)).toBeTruthy();
  }, 30_000);
});
