import { describe, expect, it, vi } from 'vitest';
import { PAGE, setup } from '../persistence/support.js';

const withInstance = () => {
  const s = setup();
  const closeConnections = vi.fn();
  const store = () => s.ext.onStoreDocument?.({ document: s.doc, documentName: PAGE, instance: { closeConnections } } as never) ?? Promise.resolve();
  return { s, closeConnections, store };
};

describe('epoch-checked saves', () => {
  it('an epoch mismatch writes nothing, logs one collab.save_refused_epoch, does not retry and closes the page connections', async () => {
    const { s, closeConnections, store } = withInstance();
    await s.edit('a'); await store();
    s.pages.epoch = 1;
    await s.edit('b'); await store();
    expect(s.pages.writes).toHaveLength(1);
    expect(s.waits).toHaveLength(0);
    expect(s.events('collab.store_failed')).toHaveLength(0);
    expect(s.events('collab.save_refused_epoch')).toHaveLength(1);
    expect(s.events('collab.save_refused_epoch')[0]?.fields).toMatchObject({ pageId: PAGE, loaded: 0, reason: 'epoch-mismatch' });
    expect(closeConnections).toHaveBeenCalledExactlyOnceWith(PAGE);
  });

  it('the store that follows the closing of the connections is not logged or closed again, and unload clears the refusal', async () => {
    const { s, closeConnections, store } = withInstance();
    await s.edit('a'); await store();
    s.pages.epoch = 1;
    await s.edit('b'); await store();
    await store();
    expect(s.events('collab.save_refused_epoch')).toHaveLength(1);
    expect(closeConnections).toHaveBeenCalledTimes(1);
    // Intended: a refused save is not retried (the clients reload and the next open loads the row as it is), so the page is not listed as unsaved.
    expect(s.ext.unsavedPages()).toEqual([]);
    await s.ext.afterUnloadDocument?.({ documentName: PAGE } as never);
    expect(s.ext.trackedPages()).toBe(0);
  });

  it('a missing row is refused the same way', async () => {
    const { s, closeConnections, store } = withInstance();
    await s.edit('a');
    s.pages.rows.delete(PAGE);
    await store();
    expect(s.events('collab.save_refused_epoch')[0]?.fields).toMatchObject({ reason: 'no-row' });
    expect(s.events('collab.store_failed')).toHaveLength(0);
    expect(s.waits).toHaveLength(0);
    expect(closeConnections).toHaveBeenCalledTimes(1);
  });
});

describe('a save that outlives its page load', () => {
  it('writes nothing and marks nothing refused when the page unloads while the conversion runs; the next load is not refused', async () => {
    const { s, closeConnections, store } = withInstance();
    await s.edit('a'); await store();
    s.pages.epoch = 1; // the row moved on: a write with a made-up epoch 0 would now be refused as a mismatch
    await s.edit('b');
    let finish: () => void = () => undefined;
    let started = false;
    const original = s.converter.toMarkdown.bind(s.converter);
    s.converter.toMarkdown = async (state: Uint8Array) => { started = true; await new Promise<void>((resolve) => { finish = resolve; }); return original(state); };
    const saving = store();
    await vi.waitFor(() => { expect(started).toBe(true); });
    await s.ext.afterUnloadDocument?.({ documentName: PAGE } as never); // every client left: the page unloads and its epoch is forgotten
    finish();
    await saving;
    expect(s.pages.writes).toHaveLength(1);
    expect(s.events('collab.save_refused_epoch')).toHaveLength(0);
    expect(closeConnections).not.toHaveBeenCalled();
    expect(s.ext.trackedPages()).toBe(0);
  });

  it('abandon() while a conversion runs: nothing is written afterwards', async () => {
    const { s, store } = withInstance();
    await s.edit('a'); await store();
    await s.edit('b');
    let finish: () => void = () => undefined;
    let started = false;
    const original = s.converter.toMarkdown.bind(s.converter);
    s.converter.toMarkdown = async (state: Uint8Array) => { started = true; await new Promise<void>((resolve) => { finish = resolve; }); return original(state); };
    const saving = store();
    await vi.waitFor(() => { expect(started).toBe(true); });
    s.ext.abandon();
    finish();
    await saving.catch(() => undefined);
    expect(s.pages.writes).toHaveLength(1);
    expect(s.events('collab.store_failed')).toHaveLength(0);
  });

  it('a page that unloads during the write is not recorded or logged as saved afterwards', async () => {
    const { s, store } = withInstance();
    await s.edit('a'); await store();
    await s.edit('b');
    const realStore = s.pages.store.bind(s.pages);
    s.pages.store = async (id, write) => { const out = await realStore(id, write); await s.ext.afterUnloadDocument?.({ documentName: PAGE } as never); return out; };
    const before = s.events('collab.saved').length;
    await store();
    expect(s.events('collab.saved')).toHaveLength(before);
    expect(s.ext.trackedPages()).toBe(0);
  });

  it('a store that fails after the page unloaded leaves no failure streak or editor record behind', async () => {
    const { s, store } = withInstance();
    await s.edit('a'); await store();
    await s.edit('b');
    s.pages.store = async () => { await s.ext.afterUnloadDocument?.({ documentName: PAGE } as never); throw new Error('database down'); };
    await store();
    expect(s.ext.trackedPages()).toBe(0);
    expect(s.events('collab.store_failed')).toHaveLength(0);
  });
});
