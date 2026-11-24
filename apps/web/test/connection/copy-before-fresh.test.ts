import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../../src/editor/core/connection';
import { flush, harness } from '../editor/support';

const established = async () => {
  const h = harness();
  const taken: { text: string | null; docDestroyedAtTheTime: boolean }[] = [];
  const options = {
    ...h.options,
    captureCopy: (s: Parameters<typeof h.options.captureCopy>[0]) => {
      const doc = s.doc as unknown as { text: string; destroyed: boolean };
      taken.push({ text: doc.text, docDestroyedAtTheTime: doc.destroyed });
      return doc.text || null;
    },
  };
  const manager = new ConnectionManager(options);
  manager.start();
  await flush();
  const first = h.last();
  first.provider.succeed(3);
  first.doc.text = 'what the tab held';
  return { h, manager, first, taken };
};

describe('the copy is taken before the document is destroyed, and held in memory only', () => {
  it('on a close access-changed the copy exists before the document is destroyed, and is held, not offered', async () => {
    const { manager, first, taken } = await established();
    first.provider.close(4205, 'access-changed');
    await flush();
    expect(taken).toEqual([{ text: 'what the tab held', docDestroyedAtTheTime: false }]);
    expect(first.doc.destroyed).toBe(true);
    expect(manager.state().copy).toBeNull(); // nothing is offered yet: the next connect decides
  });

  it('when the next connect is refused stale-epoch the held copy is offered', async () => {
    const { h, manager, first } = await established();
    first.provider.close(4205, 'access-changed');
    await flush();
    h.last().provider.refuse('stale-epoch');
    await flush();
    expect(manager.state().copy).toBe('what the tab held');
    expect(h.sessions).toHaveLength(3);
  });

  it('when the next connect is accepted the copy is dropped and no reference to it remains', async () => {
    const { h, manager, first } = await established();
    first.provider.close(4205, 'access-changed');
    await flush();
    h.last().provider.succeed(3);
    expect(manager.state().copy).toBeNull();
    // A later stale-epoch close offers what that tab holds then, not the dropped copy.
    h.last().doc.text = 'newer';
    h.last().provider.close(4409, 'stale-epoch');
    await flush();
    expect(manager.state().copy).toBe('newer');
    expect(JSON.stringify(manager.state())).not.toContain('what the tab held');
  });

  it('on a close stale-epoch the copy is offered without a second connect', async () => {
    const { h, manager, first, taken } = await established();
    first.provider.close(4409, 'stale-epoch');
    await flush();
    expect(taken[0]).toEqual({ text: 'what the tab held', docDestroyedAtTheTime: false });
    expect(manager.state().copy).toBe('what the tab held');
    expect(first.provider.connects).toBe(1);
    expect(h.sessions).toHaveLength(2);
  });

  it('is never written to a log line', async () => {
    const { h, first } = await established();
    first.provider.close(4409, 'stale-epoch');
    await flush();
    expect(h.logs.join('\n')).not.toContain('what the tab held');
  });
});
