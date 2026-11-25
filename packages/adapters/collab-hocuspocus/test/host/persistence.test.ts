import { describe, expect, it } from 'vitest';
import type { WriteOutcome } from '@tektum/grimoire-core/ports/collaboration-host';
import * as Y from 'yjs';
import { createPersistenceExtension, STORE_ALARM_AFTER } from '../../src/extensions/persistence.js';
import { makeDeps, PAGE } from './support.js';

const OK = { written: true } as const;

function setup() {
  const t = makeDeps('member');
  const sleeps: number[] = [];
  const ext = createPersistenceExtension({
    deps: t.deps, log: t.log,
    sleep: (ms) => { sleeps.push(ms); t.clock.advance(ms); return Promise.resolve(); },
  });
  const doc = new Y.Doc();
  doc.getText('prosemirror').insert(0, 'secret page content');
  const store = () => ext.onStoreDocument?.({ document: doc, documentName: PAGE } as never);
  const load = () => ext.onLoadDocument?.({ document: new Y.Doc(), documentName: PAGE, context: { peerId: 'p1' } } as never);
  return { ...t, ext, sleeps, doc, store, load };
}

describe('load', () => {
  it('missing row: refused as not-found', async () => {
    await expect(setup().load()).rejects.toMatchObject({ reason: 'not-found' });
  });
  it('row without state: nothing to apply', async () => {
    const s = setup(); s.pages.seed(PAGE, null);
    await expect(s.load()).resolves.toBeUndefined();
  });
  it('row with state: applied to the document', async () => {
    const s = setup(); s.pages.seed(PAGE, Y.encodeStateAsUpdate(s.doc));
    const target = new Y.Doc();
    await s.ext.onLoadDocument?.({ document: target, documentName: PAGE, context: { peerId: 'p1' } } as never);
    expect(target.getText('prosemirror').toString()).toBe('secret page content');
  });
  it('row with unreadable state: refused as state-corrupt, nothing written', async () => {
    const s = setup(); s.pages.seed(PAGE, new Uint8Array([255, 255, 255, 9, 9, 9, 9]));
    await expect(s.load()).rejects.toMatchObject({ reason: 'state-corrupt' });
    expect(s.pages.calls.store).toBe(0);
  });
  it('database failure: try-again', async () => {
    const s = setup(); s.pages.failLoads = true;
    await expect(s.load()).rejects.toMatchObject({ reason: 'try-again' });
  });
});

describe('store retry', () => {
  it('fails twice then succeeds: two store_failed events, backoff 1000 then 2000, no alarm', async () => {
    const s = setup(); s.pages.seed(PAGE);
    let n = 0;
    const real = s.pages.store.bind(s.pages);
    s.pages.store = (tenantId, id, w) => (++n <= 2 ? Promise.reject(new Error('down')) : real(tenantId, id, w));
    await s.store();
    expect(s.sleeps).toEqual([1000, 2000]);
    expect(s.logger.entries.map((e) => e.event).filter((e) => e !== 'collab.saved' && e !== 'collab.save_skipped')).toEqual(['collab.store_failed', 'collab.store_failed']);
    expect(s.logger.entries[1]?.fields).toEqual({ pageId: PAGE, attempt: 2, consecutive: 2, retryInMs: 2000, errorName: 'Error' });
    expect(s.pages.rows.get(PAGE)).toBeInstanceOf(Uint8Array);
  });

  it('the backoff is capped by storeRetryMaxMs and the alarm is logged exactly once, after 5 failures', async () => {
    const s = setup(); s.pages.seed(PAGE); s.pages.failStores = true;
    let n = 0;
    const real = s.pages.store.bind(s.pages);
    s.pages.store = (tenantId, id, w) => { if (++n === 9) s.pages.failStores = false; return real(tenantId, id, w); };
    await s.store();
    const events = s.logger.entries.map((e) => e.event);
    expect(events.filter((e) => e === 'collab.store_failed')).toHaveLength(8);
    expect(events.filter((e) => e === 'collab.store_alarm')).toHaveLength(1);
    expect(events.indexOf('collab.store_alarm')).toBe(STORE_ALARM_AFTER); // right after the fifth failure
    expect(Math.max(...s.sleeps)).toBe(s.deps.config.collab.storeRetryMaxMs);
  });

  it('abandon() wakes a sleeping retry at once: the loop ends, no further attempt, the sleep was aborted', async () => {
    const s = setup(); s.pages.seed(PAGE); s.pages.failStores = true;
    let aborted = false;
    const ext = createPersistenceExtension({
      deps: s.deps, log: s.log,
      sleep: (_ms, signal) => new Promise<void>((_r, rej) => { signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); }),
    });
    const p = ext.onStoreDocument?.({ document: s.doc, documentName: PAGE } as never);
    await new Promise((r) => setTimeout(r, 0));
    const calls = s.pages.calls.store;
    ext.abandon();
    await expect(p).rejects.toBeInstanceOf(Error);
    expect(aborted).toBe(true);
    expect(s.pages.calls.store).toBe(calls);
  });

  it('abandon() while a store is in flight and then fails: the loop ends without sleeping', async () => {
    const s = setup();
    let fail: (e: Error) => void = () => undefined;
    s.pages.store = () => new Promise<WriteOutcome>((_r, rej) => { fail = rej; });
    const sleeps: number[] = [];
    const ext = createPersistenceExtension({ deps: s.deps, log: s.log, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
    const p = ext.onStoreDocument?.({ document: s.doc, documentName: PAGE } as never);
    await new Promise((r) => setTimeout(r, 0));
    ext.abandon();
    fail(new Error('late'));
    await expect(p).rejects.toBeInstanceOf(Error);
    expect(sleeps).toEqual([]);
  });

  it('the state finally stored contains an edit made while the retry was waiting (re-encoded on every attempt)', async () => {
    const s = setup();
    const stored: Uint8Array[] = [];
    let n = 0;
    s.pages.store = (_tenantId, _id, w) => { if (++n === 1) return Promise.reject(new Error('down')); stored.push(w.state); return Promise.resolve(OK); };
    let release: () => void = () => undefined;
    const ext = createPersistenceExtension({ deps: s.deps, log: s.log, sleep: () => new Promise<void>((r) => { release = r; }) });
    const p = ext.onStoreDocument?.({ document: s.doc, documentName: PAGE } as never);
    await new Promise((r) => setTimeout(r, 0));
    s.doc.getText('prosemirror').insert(0, 'EDIT-DURING-WAIT ');
    release();
    await p;
    const d = new Y.Doc(); Y.applyUpdate(d, stored[0] ?? new Uint8Array());
    expect(d.getText('prosemirror').toString()).toContain('EDIT-DURING-WAIT');
  });

  it('a failure streak does not outlive the unloaded page: the counter restarts at 1', async () => {
    const s = setup(); s.pages.seed(PAGE);
    let n = 0;
    s.pages.store = () => (++n === 1 || n === 3 ? Promise.reject(new Error('x')) : Promise.resolve(OK));
    await s.store();
    await s.ext.afterUnloadDocument?.({ documentName: PAGE } as never);
    await s.store();
    const fails = s.logger.entries.filter((e) => e.event === 'collab.store_failed');
    expect(fails.map((e) => e.fields['consecutive'])).toEqual([1, 1]);
  });

  it('unsavedPages: a change adds the page, a successful store clears it, a failing one keeps it', async () => {
    const s = setup(); s.pages.seed(PAGE);
    await s.ext.onChange?.({ documentName: PAGE } as never);
    expect(s.ext.unsavedPages()).toEqual([PAGE]);
    await s.store();
    expect(s.ext.unsavedPages()).toEqual([]);
    await s.ext.onChange?.({ documentName: PAGE } as never);
    let release: () => void = () => undefined;
    const ext = createPersistenceExtension({ deps: s.deps, log: s.log, sleep: () => new Promise<void>((r) => { release = r; }) });
    s.pages.failStores = true;
    await ext.onChange?.({ documentName: PAGE } as never);
    const p = ext.onStoreDocument?.({ document: s.doc, documentName: PAGE } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(ext.unsavedPages()).toEqual([PAGE]);
    ext.abandon(); release();
    await expect(p).rejects.toBeInstanceOf(Error);
  });

  it('events carry the page id and counters only: no content, no error text', async () => {
    const s = setup(); s.pages.seed(PAGE); s.pages.failStores = true;
    let n = 0;
    const real = s.pages.store.bind(s.pages);
    s.pages.store = (tenantId, id, w) => { if (++n === 6) s.pages.failStores = false; return real(tenantId, id, w); };
    await s.store();
    const text = JSON.stringify(s.logger.entries);
    expect(text).not.toContain('secret page content');
    expect(text).not.toContain('store failed');
    expect(text).not.toMatch(/\bdown\b/); // a word: the field name `markdownBytes` contains the letters
  });

  it('onChange never throws even when the callback does', async () => {
    const t = makeDeps('member');
    const ext = createPersistenceExtension({ deps: t.deps, log: t.log, sleep: () => Promise.resolve(), onChange: () => { throw new Error('x'); } });
    await expect(ext.onChange?.({ documentName: PAGE } as never)).resolves.toBeUndefined();
  });
});

describe('the unsaved set', () => {
  const hang = () => new Promise<WriteOutcome>(() => undefined);

  it('a store that never resolves leaves the page unsaved (so shutdown reports it)', async () => {
    const s = setup(); s.pages.store = hang;
    await s.ext.onChange?.({ documentName: PAGE } as never);
    void s.store();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.ext.unsavedPages()).toEqual([PAGE]);
  });

  it('an edit arriving during an in-flight store keeps the page unsaved after that store succeeds', async () => {
    const s = setup();
    let finish: () => void = () => undefined;
    s.pages.store = () => new Promise<WriteOutcome>((r) => { finish = () => { r(OK); }; });
    await s.ext.onChange?.({ documentName: PAGE } as never);
    const p = s.store();
    await new Promise((r) => setTimeout(r, 0));
    await s.ext.onChange?.({ documentName: PAGE } as never); // the edit during the attempt
    finish(); await p;
    expect(s.ext.unsavedPages()).toEqual([PAGE]);
    s.pages.store = () => Promise.resolve(OK);
    await s.store();
    expect(s.ext.unsavedPages()).toEqual([]);
  });

  it('success after a timed-out attempt clears the page; the alarm clears with one collab.store_recovered', async () => {
    const s = setup();
    let n = 0;
    s.pages.store = () => (++n <= 5 ? Promise.reject(new Error('query timeout')) : Promise.resolve(OK));
    await s.ext.onChange?.({ documentName: PAGE } as never);
    await s.store();
    expect(s.ext.unsavedPages()).toEqual([]);
    const events = s.logger.entries.map((e) => e.event);
    expect(events.filter((e) => e === 'collab.store_alarm')).toHaveLength(1);
    expect(events.filter((e) => e === 'collab.store_recovered')).toHaveLength(1);
    expect(events.indexOf('collab.store_recovered')).toBeGreaterThan(events.indexOf('collab.store_alarm'));
  });
});


describe('a failed page load is visible (S5)', () => {
  it('is refused as try-again and logged once with the error class only; 5 in a row raise one alarm; a success resets the count', async () => {
    const s = setup(); s.pages.seed(PAGE); s.pages.failLoads = true;
    for (let i = 0; i < 5; i += 1) await expect(s.load()).rejects.toMatchObject({ reason: 'try-again' });
    const failed = s.logger.entries.filter((e) => e.event === 'collab.load_failed');
    expect(failed).toHaveLength(1); // throttled: the rest are counted in `suppressed` of the next one
    expect(failed[0]?.fields).toEqual({ errorName: 'Error', consecutive: 1, suppressed: 0 });
    expect(s.logger.entries.filter((e) => e.event === 'collab.load_alarm').map((e) => e.fields)).toEqual([{ consecutive: 5 }]);
    expect(JSON.stringify(s.logger.entries)).not.toContain('load failed'); // never the error message
    s.pages.failLoads = false;
    await s.load();
    s.pages.failLoads = true;
    s.clock.advance(11_000);
    await expect(s.load()).rejects.toMatchObject({ reason: 'try-again' });
    expect(s.logger.entries.filter((e) => e.event === 'collab.load_failed').at(-1)?.fields).toEqual({ errorName: 'Error', consecutive: 1, suppressed: 4 }); // the four held back since the first
  });

  it('a failed save names the error class in collab.store_failed', async () => {
    const s = setup(); s.pages.seed(PAGE);
    let n = 0;
    s.pages.store = () => (++n === 1 ? Promise.reject(new TypeError('x')) : Promise.resolve(OK));
    await s.store();
    expect(s.logger.entries.find((e) => e.event === 'collab.store_failed')?.fields['errorName']).toBe('TypeError');
  });
});

describe('per-page bookkeeping is released on unload (S6)', () => {
  it('10,000 load/change/store/unload cycles leave nothing tracked', async () => {
    const s = setup();
    for (let i = 0; i < 10_000; i += 1) {
      const page = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      s.pages.seed(page);
      const document = new Y.Doc();
      await s.ext.onLoadDocument?.({ document, documentName: page, context: { peerId: 'p' } } as never);
      await s.ext.onChange?.({ documentName: page } as never);
      await s.ext.onStoreDocument?.({ document, documentName: page } as never);
      await s.ext.afterUnloadDocument?.({ documentName: page } as never);
    }
    expect(s.ext.trackedPages()).toBe(0);
  }, 60_000);
});
