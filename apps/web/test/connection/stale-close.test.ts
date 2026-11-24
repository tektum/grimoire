import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../../src/editor/core/connection';
import { TEXTS } from '../../src/editor/core/map-signal';
import { decodeHandshake, flush, harness } from '../editor/support';

/** An established connection: synced at epoch 3, with unsent edits in the document. */
const established = async () => {
  const h = harness();
  const manager = new ConnectionManager(h.options);
  manager.start();
  await flush();
  const first = h.last();
  first.provider.succeed(3);
  first.doc.text = 'the page as the tab knows it, with unsent edits';
  return { h, manager, first };
};

describe('a stale epoch is never a silent reconnect', () => {
  it('a close 4409 reason stale-epoch on an established connection stops automatic reconnection, offers the copy of the unsent edits, and reopens the page once, with the new epoch', async () => {
    const { h, manager, first } = await established();
    first.provider.close(4409, 'stale-epoch');
    await flush();
    expect(first.provider.destroyed).toBe(true);
    expect(first.provider.connects).toBe(1); // the old provider is not reconnected
    expect(manager.state().copy).toBe('the page as the tab knows it, with unsent edits');
    expect(manager.state().notice).toBe(TEXTS.reset);
    expect(h.sessions).toHaveLength(2);
    const second = h.last();
    expect(second.provider.connects).toBe(1);
    await flush();
    expect(decodeHandshake(second.provider.tokens[0]!).e).toBeUndefined(); // the old epoch is gone: the server decides the new one
    second.provider.succeed(4);
    expect(manager.recordedEpoch()).toBe(4);
    await h.clock.advance(10 * 60_000);
    expect(h.sessions).toHaveLength(2); // no loop: the reload happened once
  });

  it('a connect refusal stale-epoch does the same', async () => {
    const { h, manager } = await established();
    const fresh = h.last();
    fresh.provider.refuse('stale-epoch');
    await flush();
    expect(h.sessions).toHaveLength(2);
    expect(manager.state().copy).toBe('the page as the tab knows it, with unsent edits');
    expect(h.last().provider.connects).toBe(1);
  });

  it('the refusal and the close 4409 that follows it a moment later are one reload, not two', async () => {
    const { h, first } = await established();
    first.provider.refuse('stale-epoch');
    first.provider.close(4409, 'stale-epoch'); // the socket closes about 250 ms after the refusal; the old provider is already gone
    first.provider.stateless({ kind: 'refusal', code: 'stale-epoch' });
    await flush();
    expect(h.sessions).toHaveLength(2);
    expect(h.last().provider.connects).toBe(1);
  });

  it('the reopened document holds none of the old unsent edits', async () => {
    const { h } = await established();
    h.last().provider.close(4409, 'stale-epoch');
    await flush();
    expect(h.last().doc.text).toBe('');
    expect(h.last().doc.isEmpty()).toBe(true);
  });

  it('offers nothing when there was nothing in the document', async () => {
    const h = harness();
    const manager = new ConnectionManager(h.options);
    manager.start();
    await flush();
    h.last().provider.succeed(3);
    h.last().provider.close(4409, 'stale-epoch');
    await flush();
    expect(manager.state().copy).toBeNull();
    expect(h.sessions).toHaveLength(2);
  });

  it('the copy stays until it is dismissed, and dismissing drops it', async () => {
    const { h, manager } = await established();
    h.last().provider.close(4409, 'stale-epoch');
    await flush();
    h.last().provider.succeed(4);
    expect(manager.state().copy).not.toBeNull(); // a sync of the new session does not take it away
    manager.dismissCopy();
    expect(manager.state().copy).toBeNull();
  });
});
