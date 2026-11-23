import { describe, expect, it } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { createCollabLog } from '../../src/events.js';
import { createRevisionsExtension } from '../../src/extensions/revisions.js';
import { PeerRegistry } from '../../src/peers.js';
import { REFUSAL_CLOSE_CODES } from '../../src/refusal.js';
import { buildExtensions } from '../../src/registry.js';
import { makeDeps } from '../host/support.js';
import { ANA, FakeTimers, MINUTE, PAGE } from './support.js';

function make() {
  const clock = new FakeClock(1_700_000_000_000);
  const timers = new FakeTimers(clock);
  const repo = new FakeRevisionRepo();
  const logger = new FakeLogger();
  const ext = createRevisionsExtension({ repo, clock, log: createCollabLog(logger), timers });
  return { ext, repo, timers, clock, logger };
}
const payload = (over: Record<string, unknown> = {}) => ({ documentName: PAGE, context: { userId: ANA }, ...over }) as never;

describe('the revisions extension', () => {
  it('turns a change, a save, an unload and a load into the scheduler\'s calls', async () => {
    const t = make();
    t.repo.setPage(PAGE, { title: 'T', markdown: 'one', lastEditedAt: t.clock.now() - 10 * MINUTE, lastEditedBy: ANA });
    await t.ext.afterLoadDocument?.(payload());
    await t.ext.scheduler.whenIdle();
    expect(t.repo.made(PAGE)).toEqual([expect.objectContaining({ reason: 'idle' })]);
    t.repo.setPage(PAGE, { title: 'T', markdown: 'two' });
    await t.ext.onChange?.(payload());
    expect(t.timers.pending).toBe(1);
    await t.ext.afterStoreDocument?.(payload());
    await t.ext.afterUnloadDocument?.(payload());
    expect(t.repo.made(PAGE).map((r) => [r.reason, r.markdown, r.authors])).toEqual([['idle', 'one', [ANA]], ['last_editor_left', 'two', [ANA]]]);
    expect(t.timers.pending).toBe(0);
  });

  it('reads the editor from the connection context, and takes a change with no context as no editor', async () => {
    const t = make();
    t.repo.setPage(PAGE, { title: 'T', markdown: 'text' });
    await t.ext.onChange?.(payload({ context: undefined }));
    await t.ext.afterUnloadDocument?.(payload());
    expect(t.repo.made(PAGE)).toEqual([expect.objectContaining({ authors: [], lastAuthorId: null })]);
  });

  it('cancels its timers and waits for work when the server is destroyed', async () => {
    const t = make();
    t.repo.setPage(PAGE, { title: 'T', markdown: 'text' });
    await t.ext.onChange?.(payload());
    await t.ext.onDestroy?.({} as never);
    expect(t.timers.pending).toBe(0);
  });
});

describe('the registry', () => {
  it('registers the extension by one line, after the persistence and without changing the order of the others', () => {
    const t = makeDeps();
    const { extensions } = buildExtensions({ deps: t.deps, log: t.log, peers: new PeerRegistry(REFUSAL_CLOSE_CODES), guard: {} as never, sleep: () => new Promise(() => undefined) });
    expect(extensions.map((e) => e.extensionName)).toEqual([
      'grimoire-auth', 'grimoire-handshake', 'grimoire-limits', 'grimoire-presence', 'grimoire-recheck', 'grimoire-persistence', 'grimoire-revisions',
    ]);
    expect(extensions.at(-1)?.priority).toBeLessThan(extensions.find((e) => e.extensionName === 'grimoire-persistence')?.priority ?? 0);
  });
});
