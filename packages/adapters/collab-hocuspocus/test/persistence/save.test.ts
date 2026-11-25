import type { ConvertFailure, ConvertResult } from '@tektum/grimoire-core/ports/markdown-converter';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { createPersistenceExtension } from '../../src/extensions/persistence.js';
import { ALICE, BOB, okOf, PAGE, seedDoc, setup, textOf } from './support.js';

const fail = (reason: ConvertFailure, detail: string): ConvertResult => ({ ok: false, reason, detail });
const kinds = (s: ReturnType<typeof setup>) => s.events('collab.convert_failed').map((e) => e.fields['kind']);

describe('a converted save', () => {
  it('writes state, Markdown, text, the SHA-256 of the UTF-8 Markdown, the editor and the edit time, and logs collab.saved', async () => {
    const s = setup();
    await s.edit('Zażółć', ALICE);
    await s.store();
    const w = s.pages.writes[0];
    expect(w?.kind).toBe('converted');
    expect(s.pages.markdowns.get(PAGE)).toBe('Zażółć');
    expect(s.pages.texts.get(PAGE)).toBe('zażółć');
    expect(s.pages.hashes.get(PAGE)?.byteLength).toBe(32);
    expect(s.pages.editors.get(PAGE)).toBe(ALICE);
    expect(w?.kind === 'converted' && w.editedAt).toBe(s.clock.now());
    expect(textOf(s.pages.rows.get(PAGE) ?? new Uint8Array())).toBe('Zażółć');
    const saved = s.events('collab.saved')[0]?.fields;
    expect(Object.keys(saved ?? {}).sort()).toEqual(['convertMs', 'markdownBytes', 'pageId', 'stateBytes', 'writeMs']);
    expect(saved?.['markdownBytes']).toBe(Buffer.byteLength('Zażółć'));
  });

  it('saving twice without a change writes nothing the second time and logs one collab.save_skipped', async () => {
    const s = setup();
    await s.edit('same');
    await s.store();
    await s.store();
    expect(s.pages.writes).toHaveLength(1);
    expect(s.pages.calls.store).toBe(2);
    expect(s.events('collab.save_skipped')).toHaveLength(1);
  });

  it('the converter gets a copy: the state written to the database is the caller\'s own bytes', async () => {
    const s = setup();
    await s.edit('x');
    await s.store();
    const given = s.converter.convertCalls[0];
    expect(given).toBeDefined();
    expect(given).not.toBe(s.pages.writes[0]?.state);
    expect(given?.buffer).not.toBe(s.pages.writes[0]?.state.buffer);
  });
});

describe('editors (R4.22)', () => {
  it('two users edit alternately: the row names the user whose update arrived last', async () => {
    const s = setup();
    await s.edit('a', ALICE); await s.edit('b', BOB); await s.store();
    expect(s.pages.editors.get(PAGE)).toBe(BOB);
    await s.edit('c', ALICE); await s.store();
    expect(s.pages.editors.get(PAGE)).toBe(ALICE);
  });

  it('a user id that is not a UUID leaves the editor empty', async () => {
    const s = setup();
    await s.edit('a', 'dev-alice'); await s.store();
    expect(s.pages.writes[0]).toMatchObject({ kind: 'converted' });
    expect(s.pages.editors.get(PAGE)).toBeUndefined();
  });

  it('after a failed write the editor record is restored and the retry stores it', async () => {
    const s = setup();
    await s.edit('a', ALICE);
    let n = 0;
    const real = s.pages.store.bind(s.pages);
    s.pages.store = (tenantId, id, w) => (++n === 1 ? Promise.reject(new Error('down')) : real(tenantId, id, w));
    const p = s.store();
    await s.flush();
    s.waits[0]?.release();
    await p;
    expect(s.pages.editors.get(PAGE)).toBe(ALICE);
  });

  it('a conversion failure does not consume the editor: the later conversion stores it', async () => {
    const s = setup();
    s.converter.enqueueConvert(fail('content-lost', 'x'));
    await s.edit('a', ALICE); await s.store();
    expect(s.pages.editors.has(PAGE)).toBe(false);
    await s.store();
    expect(s.pages.editors.get(PAGE)).toBe(ALICE);
  });
});

describe('conversion failures (R7.8, corrections 1 and 2)', () => {
  const BROKEN: [ConvertFailure, string][] = [
    ['invalid-state', 'bad'], ['too-large', 'big'], ['too-deep', 'deep'], ['content-lost', 'lost'],
    ['timeout', 'the conversion exceeded its time limit'], ['out-of-memory', 'oom'], ['internal', 'worker-failed'],
  ];

  it.each(BROKEN)('%s: the live state is stored, the previous Markdown, text and hash stay byte-equal, one convert_failed (broken)', async (reason, detail) => {
    const s = setup();
    await s.edit('first', ALICE); await s.store();
    const before = { md: s.pages.markdowns.get(PAGE), text: s.pages.texts.get(PAGE), hash: s.pages.hashes.get(PAGE) };
    s.converter.enqueueConvert(fail(reason, detail));
    await s.edit('second', BOB); await s.store();
    expect(textOf(s.pages.rows.get(PAGE) ?? new Uint8Array())).toContain('second');
    expect(s.pages.markdowns.get(PAGE)).toBe(before.md);
    expect(s.pages.texts.get(PAGE)).toBe(before.text);
    expect(s.pages.hashes.get(PAGE)).toEqual(before.hash);
    expect(s.events('collab.convert_failed')).toHaveLength(1);
    expect(s.events('collab.convert_failed')[0]?.fields).toEqual({ pageId: PAGE, kind: 'broken', reason, detail });
    expect(s.pages.stale.get(PAGE)).not.toBeNull(); // marked stale in the row
  });

  it('the alarm is raised once for three failures in a row, and again after a success and a new failure', async () => {
    const s = setup();
    for (const r of ['too-large', 'too-deep', 'content-lost'] as const) { s.converter.enqueueConvert(fail(r, 'x')); await s.edit('e'); await s.store(); }
    expect(s.events('collab.convert_failed')).toHaveLength(3);
    expect(s.events('collab.convert_alarm')).toHaveLength(1);
    await s.edit('ok'); await s.store();
    expect(s.pages.stale.get(PAGE)).toBeNull();
    s.converter.enqueueConvert(fail('invalid-state', 'x')); await s.edit('e'); await s.store();
    expect(s.events('collab.convert_alarm')).toHaveLength(2);
  });

  it('a page after a refusal and a state-only write converts the same Markdown again without being skipped as unchanged', async () => {
    const s = setup();
    await s.edit('A'); await s.store();
    const hash = s.pages.hashes.get(PAGE);
    s.converter.enqueueConvert(fail('too-large', 'x'));
    await s.edit('B'); await s.store(); // state holds "BA", Markdown still "A"
    s.doc.getText('prosemirror').delete(0, 1);
    s.converter.enqueueConvert({ ok: true, markdown: 'A', text: 'a' }); // the same Markdown as before
    await s.store();
    expect(s.pages.hashes.get(PAGE)).toEqual(hash);
    expect(textOf(s.pages.rows.get(PAGE) ?? new Uint8Array())).toBe('A'); // the state is not left at "BA"
  });

  it.each([['internal', 'queue-full'], ['internal', 'closed'], ['timeout', 'waiting-for-converter']] as const)(
    'busy (%s, %s): the state is stored, logged as busy, no alarm and the streak is untouched',
    async (reason, detail) => {
      const s = setup({ convertRetryLimit: 0 });
      for (let i = 0; i < 4; i++) { s.converter.enqueueConvert(fail(reason, detail)); await s.edit('e'); await s.store(); }
      expect(kinds(s)).toEqual(['busy', 'busy', 'busy', 'busy']);
      expect(s.events('collab.convert_alarm')).toHaveLength(0);
      expect(s.pages.writes).toHaveLength(4);
      s.converter.enqueueConvert(fail('too-large', 'x')); await s.edit('e'); await s.store();
      expect(s.events('collab.convert_alarm')).toHaveLength(1); // the first real failure is the first of its streak
    },
  );

  it('logs fixed strings only: never page text, Markdown or state bytes (correction 6)', async () => {
    const s = setup();
    s.converter.enqueueConvert(fail('content-lost', 'fixed'));
    await s.edit('PAGE SECRET TEXT', ALICE); await s.store();
    await s.edit('MORE SECRET'); await s.store();
    expect(JSON.stringify(s.logger.entries)).not.toMatch(/SECRET/i);
  });
});

describe('a busy save is converted later (correction 1)', () => {
  it('without another edit: a timer converts the page, with backoff, and the Markdown arrives', async () => {
    const s = setup();
    s.converter.enqueueConvert(fail('internal', 'queue-full'));
    await s.edit('late'); await s.store();
    expect(s.pages.markdowns.get(PAGE)).toBeNull();
    expect(s.waits.map((w) => w.ms)).toEqual([2000]);
    s.waits[0]?.release(); await s.flush();
    expect(s.pages.markdowns.get(PAGE)).toBe('late');
    expect(s.events('collab.convert_retry')).toHaveLength(1);
    expect(s.waits).toHaveLength(1); // converted: nothing more scheduled
    expect(s.pages.stale.get(PAGE)).toBeNull();
  });

  it('keeps trying with doubling waits up to the limit, then leaves it to the final save', async () => {
    const s = setup({ convertRetryLimit: 3 });
    for (let i = 0; i < 4; i++) s.converter.enqueueConvert(fail('internal', 'queue-full'));
    await s.edit('late'); await s.store();
    for (let i = 0; i < 3; i++) { s.waits[i]?.release(); await s.flush(); }
    expect(s.waits.map((w) => w.ms)).toEqual([2000, 4000, 8000]);
    expect(s.pages.markdowns.get(PAGE)).toBeNull();
    s.converter.enqueueConvert(okOf); // the final save at unload
    await s.store();
    expect(s.pages.markdowns.get(PAGE)).toBe('late');
  });

  it('a broken conversion is not retried; an edit, unloading and shutdown cancel the timer', async () => {
    const s = setup();
    s.converter.enqueueConvert(fail('too-large', 'x'));
    await s.edit('a'); await s.store();
    expect(s.waits).toHaveLength(0);
    s.converter.enqueueConvert(fail('internal', 'queue-full'));
    await s.edit('b'); await s.store();
    expect(s.waits).toHaveLength(1);
    await s.store(); // any save of the page converts it and cancels the pending timer
    s.waits[0]?.release(); await s.flush();
    expect(s.events('collab.convert_retry')).toHaveLength(0);
    s.converter.enqueueConvert(fail('internal', 'queue-full')); await s.edit('c'); await s.store();
    await s.ext.afterUnloadDocument?.({ documentName: PAGE } as never);
    s.waits[1]?.release(); await s.flush();
    expect(s.events('collab.convert_retry')).toHaveLength(0);
    s.converter.enqueueConvert(fail('internal', 'queue-full')); await s.edit('d'); await s.store();
    s.ext.beginShutdown();
    s.waits[2]?.release(); await s.flush();
    expect(s.events('collab.convert_retry')).toHaveLength(0);
    s.converter.enqueueConvert(fail('internal', 'queue-full')); await s.edit('e'); await s.store();
    expect(s.waits).toHaveLength(3); // draining: nothing new is scheduled
  });
});

describe('order of saves (correction 4)', () => {
  it('two quick saves where the first conversion is slower: the newer state and Markdown win', async () => {
    const s = setup();
    const trace: string[] = [];
    let n = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    s.converter.enqueueConvert(async (state) => {
      const k = ++n;
      trace.push(`start-${String(k)}`);
      if (k === 1) await held; // the first conversion stays running until the test lets it end
      trace.push(`end-${String(k)}`);
      return okOf(state);
    });
    await s.edit('old');
    const first = s.store();
    await s.flush(); // the first conversion is running on the old state
    await s.edit('new');
    const second = s.store();
    await s.flush();
    expect(trace).toEqual(['start-1']); // while the first is held the second has not started
    release();
    await Promise.all([first, second]);
    expect(s.pages.markdowns.get(PAGE)).toBe('newold');
    expect(s.pages.writes.map((w) => (w.kind === 'converted' ? w.markdown : ''))).toEqual(['old', 'newold']);
    expect(textOf(s.pages.rows.get(PAGE) ?? new Uint8Array())).toBe('newold');
    expect(trace.slice(0, 2)).toEqual(['start-1', 'end-1']); // the second conversion does not start before the first has been written
  });
});

describe('epoch and absent rows are left to the host', () => {
  it('store-level epoch-mismatch writes nothing and is not retried', async () => {
    const s = setup();
    await s.edit('a'); await s.store();
    s.pages.epoch = 1;
    await s.edit('b'); await s.store();
    expect(s.pages.writes).toHaveLength(1);
    expect(s.waits).toHaveLength(0);
  });
});

describe('seeding', () => {
  const load = (s: ReturnType<typeof setup>) => s.ext.onLoadDocument?.({ document: new Y.Doc(), documentName: PAGE, context: { peerId: 'p1' } } as never);

  it('a row with Markdown and no state opens with the seeded state and logs one collab.seed', async () => {
    const s = setup();
    s.pages.markdowns.set(PAGE, '# Hi');
    const seeded = seedDoc('seeded');
    s.converter.enqueueSeed({ ok: true, state: Y.encodeStateAsUpdate(seeded) });
    const target = new Y.Doc();
    await s.ext.onLoadDocument?.({ document: target, documentName: PAGE, context: { peerId: 'p1' } } as never);
    expect(target.getXmlFragment('prosemirror').toString()).toContain('seeded');
    expect(s.converter.seedCalls).toEqual(['# Hi']);
    const seeds = s.events('collab.seed');
    expect(seeds).toHaveLength(1);
    expect(Object.keys(seeds[0]?.fields ?? {}).sort()).toEqual(['bytes', 'ms', 'pageId']);
  });

  it('a seed failure refuses the connect as seed-failed and logs collab.seed_failed', async () => {
    const s = setup();
    s.pages.markdowns.set(PAGE, '# Hi');
    s.converter.enqueueSeed({ ok: false, reason: 'invalid-markdown', detail: 'x' });
    await expect(load(s)).rejects.toMatchObject({ reason: 'seed-failed' });
    expect(s.events('collab.seed_failed')[0]?.fields).toEqual({ pageId: PAGE, reason: 'invalid-markdown' });
    expect(s.pages.rows.get(PAGE)).toBeNull();
  });

  it('a busy converter is "try again", not a failed page', async () => {
    const s = setup();
    s.pages.markdowns.set(PAGE, '# Hi');
    s.converter.enqueueSeed({ ok: false, reason: 'internal', detail: 'queue-full' });
    await expect(load(s)).rejects.toMatchObject({ reason: 'try-again' });
  });

  it('a row without Markdown and without state opens empty and calls no converter', async () => {
    const s = setup();
    await expect(load(s)).resolves.toBeUndefined();
    expect(s.converter.seedCalls).toEqual([]);
  });
});

describe('stale Markdown survives a restart and is converted on load', () => {
  const afterLoad = (s: ReturnType<typeof setup>, doc: Y.Doc) => s.ext.afterLoadDocument?.({ document: doc, documentName: PAGE } as never);

  it('a state-only save marks the row; a fresh extension on the same store (a restart) converts the page when it is opened, without an edit', async () => {
    const s = setup({ convertRetryLimit: 0 });
    s.converter.enqueueConvert(fail('internal', 'queue-full'));
    await s.edit('typed'); await s.store();
    expect(s.pages.stale.get(PAGE)).not.toBeNull();
    expect(s.pages.markdowns.get(PAGE)).toBeNull();
    // restart: a new extension, the same rows
    const doc = new Y.Doc();
    const ext = createPersistenceExtension({ deps: { ...s.deps }, log: s.log, sleep: () => new Promise(() => undefined) });
    await ext.onLoadDocument?.({ document: doc, documentName: PAGE, context: { peerId: 'p1' } } as never);
    await ext.afterLoadDocument?.({ document: doc, documentName: PAGE } as never);
    await s.flush();
    expect(s.pages.markdowns.get(PAGE)).toBe('typed');
    expect(s.pages.stale.get(PAGE)).toBeNull();
  });

  it('opening a page with a refused conversion converts it once per load, not in a loop', async () => {
    const s = setup();
    await s.edit('x'); await s.store();
    s.pages.stale.set(PAGE, 1);
    s.converter.enqueueConvert(fail('content-lost', 'x'));
    const doc = new Y.Doc();
    await s.ext.onLoadDocument?.({ document: doc, documentName: PAGE, context: { peerId: 'p1' } } as never);
    const calls = s.converter.convertCalls.length;
    await afterLoad(s, doc); await s.flush();
    expect(s.converter.convertCalls.length).toBe(calls + 1);
    expect(s.waits).toHaveLength(0); // no timer for a refusal
    await s.flush();
    expect(s.converter.convertCalls.length).toBe(calls + 1);
    expect(s.pages.stale.get(PAGE)).not.toBeNull();
    // the next load tries once more
    await s.ext.afterUnloadDocument?.({ documentName: PAGE } as never);
    const again = new Y.Doc();
    await s.ext.onLoadDocument?.({ document: again, documentName: PAGE, context: { peerId: 'p1' } } as never);
    await afterLoad(s, again); await s.flush();
    expect(s.converter.convertCalls.length).toBe(calls + 2);
  });

  it('a page that is not stale is not converted on load', async () => {
    const s = setup();
    const doc = new Y.Doc();
    await s.ext.onLoadDocument?.({ document: doc, documentName: PAGE, context: { peerId: 'p1' } } as never);
    await afterLoad(s, doc); await s.flush();
    expect(s.converter.convertCalls).toHaveLength(0);
  });
});

describe('nothing is scheduled or saved for an unloaded page (fix round, item 1)', () => {
  it('a retry whose save is still running at unload does not re-arm the timer, and a timer that fires after shutdown began saves nothing', async () => {
    const s = setup();
    s.converter.enqueueConvert(fail('internal', 'queue-full'));
    await s.edit('late'); await s.store();
    expect(s.waits).toHaveLength(1);
    let finish: (r: ConvertResult) => void = () => undefined;
    // the retry's conversion hangs until released, and answers busy again
    s.converter.enqueueConvert(() => new Promise<ConvertResult>((r) => { finish = r; }) as never);
    s.waits[0]?.release(); await s.flush(); // the retry is now running
    await s.ext.afterUnloadDocument?.({ documentName: PAGE } as never); // the page unloads meanwhile
    finish(fail('internal', 'queue-full'));
    await s.flush();
    expect(s.waits).toHaveLength(1); // nothing re-armed
    const stores = s.pages.calls.store;
    s.waits[0]?.release(); await s.flush();
    expect(s.pages.calls.store).toBe(stores);
  });

  it('after beginShutdown a timer that was already due saves nothing', async () => {
    const s = setup();
    s.converter.enqueueConvert(fail('internal', 'queue-full'));
    await s.edit('late'); await s.store();
    const stores = s.pages.calls.store;
    s.ext.beginShutdown();
    s.waits[0]?.release(); await s.flush();
    expect(s.pages.calls.store).toBe(stores);
  });
});

describe('seed refusals are remembered (fix round, item 4)', () => {
  const load = (s: ReturnType<typeof setup>) => s.ext.onLoadDocument?.({ document: new Y.Doc(), documentName: PAGE, context: { peerId: 'p1' } } as never);

  it('the same Markdown is refused again without converting; changed Markdown is tried again; a busy answer is not remembered', async () => {
    const s = setup();
    s.pages.markdowns.set(PAGE, 'bad');
    s.converter.enqueueSeed({ ok: false, reason: 'invalid-markdown', detail: 'x' });
    await expect(load(s)).rejects.toMatchObject({ reason: 'seed-failed' });
    await expect(load(s)).rejects.toMatchObject({ reason: 'seed-failed' });
    await expect(load(s)).rejects.toMatchObject({ reason: 'seed-failed' });
    expect(s.converter.seedCalls).toEqual(['bad']);
    s.pages.markdowns.set(PAGE, 'edited');
    s.converter.enqueueSeed({ ok: false, reason: 'internal', detail: 'queue-full' });
    await expect(load(s)).rejects.toMatchObject({ reason: 'try-again' });
    s.converter.enqueueSeed({ ok: true, state: Y.encodeStateAsUpdate(new Y.Doc()) });
    await expect(load(s)).resolves.toBeUndefined();
    expect(s.converter.seedCalls).toEqual(['bad', 'edited', 'edited']);
  });

  it('a worker failure, a worker exit or a timeout is NOT remembered: the next open converts the same Markdown again', async () => {
    for (const [reason, detail] of [['internal', 'worker-failed'], ['internal', 'worker-exited'], ['timeout', 'run']] as const) {
      const s = setup();
      s.pages.markdowns.set(PAGE, 'fine');
      s.converter.enqueueSeed({ ok: false, reason, detail });
      await expect(load(s)).rejects.toMatchObject({ reason: 'try-again' }); // the client may reconnect: nothing here repeats
      s.converter.enqueueSeed({ ok: true, state: Y.encodeStateAsUpdate(new Y.Doc()) });
      await expect(load(s)).resolves.toBeUndefined();
      expect(s.converter.seedCalls).toEqual(['fine', 'fine']);
    }
  });
});

describe('order of saves: the per-page chain is the guarantee (fix round, item 3)', () => {
  it('a first save whose database write is slow cannot land after a second save of the same page', async () => {
    const s = setup();
    const real = s.pages.store.bind(s.pages);
    let n = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    s.pages.store = async (tenantId, id, w) => { if (++n === 1) await held; return real(tenantId, id, w); }; // the first write stays pending until the test lets it go
    await s.edit('old');
    const first = s.store();
    await s.flush();
    await s.edit('new');
    const second = s.store();
    await s.flush();
    expect(s.pages.writes).toEqual([]); // nothing landed yet: the second save is queued behind the first write
    release();
    await Promise.all([first, second]);
    expect(s.pages.writes.map((w) => (w.kind === 'converted' ? w.markdown : ''))).toEqual(['old', 'newold']);
    expect(s.pages.markdowns.get(PAGE)).toBe('newold');
  });
});

describe('a load that fails half way leaves no stale marker for the next load', () => {
  const open = async (s: ReturnType<typeof setup>, doc: Y.Doc) => {
    await s.ext.onLoadDocument?.({ document: doc, documentName: PAGE, context: { peerId: 'p1' } } as never);
    await s.ext.afterLoadDocument?.({ document: doc, documentName: PAGE } as never);
    await s.flush();
  };
  const typed = (): Uint8Array => { const d = new Y.Doc(); d.getText('prosemirror').insert(0, 'typed'); return Y.encodeStateAsUpdate(d); };

  it('the next successful load of a page whose Markdown is current does not convert it again', async () => {
    const s = setup();
    s.pages.markdowns.set(PAGE, 'current');
    s.pages.rows.set(PAGE, Uint8Array.from([255, 255, 255, 255, 255])); // stored state that cannot be applied
    s.pages.stale.set(PAGE, 1); // the first load sees the Markdown as stale
    await expect(s.ext.onLoadDocument?.({ document: new Y.Doc(), documentName: PAGE, context: { peerId: 'p1' } } as never)).rejects.toBeDefined();
    s.pages.rows.set(PAGE, typed());
    s.pages.stale.set(PAGE, null);
    await open(s, new Y.Doc());
    expect(s.converter.convertCalls).toHaveLength(0);
    // Control: the same page with the Markdown really stale is converted on open, so the check above can fail.
    const t = setup();
    t.pages.markdowns.set(PAGE, 'current');
    t.pages.rows.set(PAGE, typed());
    t.pages.stale.set(PAGE, 1);
    await open(t, new Y.Doc());
    expect(t.converter.convertCalls).toHaveLength(1);
  });
});
