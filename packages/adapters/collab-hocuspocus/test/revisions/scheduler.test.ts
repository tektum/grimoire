import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { createCollabLog } from '../../src/events.js';
import { revisionReport } from '../../src/extensions/revisions.js';
import { createRevisionScheduler } from '../../src/revisions/scheduler.js';
import { ANA, BOB, MINUTE, PAGE, build } from './support.js';

const saved = (b: ReturnType<typeof build>, markdown: string, over: { title?: string; stale?: boolean } = {}) =>
  b.repo.setPage(PAGE, { title: over.title ?? 'Title', markdown, ...(over.stale === undefined ? {} : { stale: over.stale }) });

describe('the 5-minute rule (R9.2)', () => {
  it('one edit then 5 minutes without another makes exactly one revision with reason idle, dated at the last edit', async () => {
    const b = build();
    saved(b, 'one');
    b.scheduler.changed(PAGE, ANA);
    const editedAt = b.clock.now();
    b.timers.advance(5 * MINUTE - 1);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([]);
    b.timers.advance(1);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ reason: 'idle', createdAt: editedAt, markdown: 'one', authors: [ANA], lastAuthorId: ANA })]);
    b.timers.advance(60 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toHaveLength(1);
  });

  it('a further edit before the 5 minutes restarts the timer, and the revision is dated at the last edit with every author', async () => {
    const b = build();
    saved(b, 'one');
    b.scheduler.changed(PAGE, ANA);
    b.timers.advance(4 * MINUTE);
    b.scheduler.changed(PAGE, BOB);
    const lastEditAt = b.clock.now();
    b.timers.advance(4 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([]);
    b.timers.advance(MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ createdAt: lastEditAt, authors: [ANA, BOB], lastAuthorId: BOB })]);
  });

  it('keeps one timer per page and starts a fresh record after a revision', async () => {
    const b = build();
    saved(b, 'one');
    b.scheduler.changed(PAGE, ANA);
    b.scheduler.changed(PAGE, ANA);
    expect(b.timers.pending).toBe(1);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    saved(b, 'two');
    b.scheduler.changed(PAGE, BOB);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE).map((r) => [r.markdown, r.authors])).toEqual([['one', [ANA]], ['two', [BOB]]]);
  });

  it('makes none when title and Markdown equal the latest revision', async () => {
    const b = build();
    saved(b, 'same');
    b.scheduler.changed(PAGE, ANA);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    b.scheduler.changed(PAGE, ANA);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toHaveLength(1);
    expect(b.events('collab.revision_created')).toHaveLength(1);
  });

  it('makes none for a page with no saved Markdown or no page, and forgets the edits', async () => {
    const b = build();
    b.repo.setPage(PAGE, { title: 'T', markdown: null });
    b.scheduler.changed(PAGE, ANA);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    b.scheduler.changed('00000000-0000-4000-8000-0000000000d4', ANA);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([]);
    expect(b.events('collab.revision_created')).toEqual([]);
    await b.scheduler.unloaded(PAGE);
    expect(b.repo.calls).toHaveLength(2);
  });

  it('records no author for a user id that is not a UUID, and still makes the revision', async () => {
    const b = build();
    saved(b, 'one');
    b.scheduler.changed(PAGE, 'dev-user-name');
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ authors: [], lastAuthorId: null })]);
  });
});

describe('the last editor leaving', () => {
  it('makes a revision with reason last_editor_left at once, and cancels the timer', async () => {
    const b = build();
    saved(b, 'final');
    b.scheduler.changed(PAGE, ANA);
    await b.scheduler.unloaded(PAGE);
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ reason: 'last_editor_left', markdown: 'final', authors: [ANA] })]);
    expect(b.timers.pending).toBe(0);
    b.timers.advance(10 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toHaveLength(1);
  });

  it('makes none for a page nobody changed: a refused or viewing connection that closes costs no database call', async () => {
    const b = build();
    saved(b, 'untouched');
    await b.scheduler.unloaded(PAGE);
    expect(b.repo.made(PAGE)).toEqual([]);
    expect(b.repo.calls).toEqual([]);
  });

  it('makes none when the content equals the latest revision', async () => {
    const b = build();
    saved(b, 'same');
    b.scheduler.changed(PAGE, ANA);
    await b.scheduler.unloaded(PAGE);
    b.scheduler.changed(PAGE, ANA);
    await b.scheduler.unloaded(PAGE);
    expect(b.repo.made(PAGE)).toHaveLength(1);
  });
});

describe('stale Markdown', () => {
  it('defers while the flag is set with one collab.revision_deferred, and makes the revision at the save that clears it', async () => {
    const b = build();
    saved(b, 'old', { stale: true });
    b.scheduler.changed(PAGE, ANA);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    await b.scheduler.unloaded(PAGE);
    expect(b.repo.made(PAGE)).toEqual([]);
    expect(b.events('collab.revision_deferred')).toEqual([expect.objectContaining({ fields: { pageId: PAGE } })]);
    await b.scheduler.saved(PAGE);
    expect(b.repo.made(PAGE)).toEqual([]);
    expect(b.events('collab.revision_deferred')).toHaveLength(1);
    saved(b, 'fresh');
    await b.scheduler.saved(PAGE);
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ markdown: 'fresh', reason: 'last_editor_left', authors: [ANA] })]);
    await b.scheduler.saved(PAGE);
    expect(b.repo.made(PAGE)).toHaveLength(1);
  });
});

describe('what each revision logs', () => {
  it('logs exactly one collab.revision_created with the page id and the reason, and nothing of the title or Markdown', async () => {
    const b = build();
    saved(b, 'secret text', { title: 'Secret title' });
    b.scheduler.changed(PAGE, ANA);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.events('collab.revision_created')).toEqual([{ level: 'info', event: 'collab.revision_created', fields: { pageId: PAGE, reason: 'idle' } }]);
    expect(JSON.stringify(b.logger.entries)).not.toMatch(/secret/i);
  });

  it('logs a failed attempt without text, and keeps the edits owed for the next trigger', async () => {
    const b = build();
    saved(b, 'text');
    b.scheduler.changed(PAGE, ANA);
    b.repo.failNext = new RangeError('database down');
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.events('collab.revision_failed')).toEqual([expect.objectContaining({ fields: { pageId: PAGE, errorName: 'RangeError' } })]);
    expect(b.repo.made(PAGE)).toEqual([]);
    await b.scheduler.unloaded(PAGE);
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ reason: 'last_editor_left' })]);
  });
});

describe('the catch-up after a restart (R9.3)', () => {
  it('does no database work until a page is opened', async () => {
    const b = build();
    b.repo.setPage(PAGE, { title: 'T', markdown: 'm', lastEditedAt: b.clock.now() - 6 * MINUTE, lastEditedBy: ANA });
    b.timers.advance(60 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.calls).toEqual([]);
  });

  it('makes the missing revision at the first open, dated at the last edit, and none at a second open', async () => {
    const b = build();
    const editedAt = b.clock.now() - 6 * MINUTE;
    b.repo.setPage(PAGE, { title: 'T', markdown: 'saved before the restart', lastEditedAt: editedAt, lastEditedBy: ANA });
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ reason: 'idle', createdAt: editedAt, authors: [ANA], markdown: 'saved before the restart' })]);
    expect(b.events('collab.revision_created')).toEqual([expect.objectContaining({ fields: { pageId: PAGE, reason: 'idle' } })]);
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toHaveLength(1);
    expect(b.repo.calls).toEqual(['catchUp']);
  });

  it('leaves a page saved less than 5 minutes ago to its own timer, and one that already has its revision alone', async () => {
    const b = build();
    b.repo.setPage(PAGE, { title: 'T', markdown: 'recent', lastEditedAt: b.clock.now() - 4 * MINUTE, lastEditedBy: ANA });
    const done = '00000000-0000-4000-8000-0000000000e5';
    b.repo.setPage(done, { title: 'T', markdown: 'kept', lastEditedAt: b.clock.now() - 9 * MINUTE, lastEditedBy: ANA });
    b.repo.seed({ pageId: done, createdAt: b.clock.now() - 9 * MINUTE, title: 'T', markdown: 'kept' });
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([]);
    expect(b.repo.made(done)).toHaveLength(1);
  });

  it('works through more pages than one batch holds, and logs a failure without giving up the server', async () => {
    const b = build();
    for (let n = 0; n < 501; n += 1) b.repo.setPage(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, { title: 'T', markdown: `m${String(n)}`, lastEditedAt: b.clock.now() - 6 * MINUTE - n, lastEditedBy: ANA });
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.events('collab.revision_created')).toHaveLength(501);
    expect(b.repo.calls).toEqual(['catchUp', 'catchUp']);
    const failing = build();
    failing.repo.failNext = new Error('database down');
    failing.scheduler.opened();
    await failing.scheduler.whenIdle();
    expect(failing.events('collab.revision_failed')).toEqual([expect.objectContaining({ fields: { pageId: 'catch-up', errorName: 'Error' } })]);
  });
});

describe('stopping', () => {
  it('cancels every timer', () => {
    const b = build();
    b.scheduler.changed(PAGE, ANA);
    expect(b.timers.pending).toBe(1);
    b.scheduler.stop();
    expect(b.timers.pending).toBe(0);
  });
});

describe('the default timers', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('are the global ones: with vitest fake timers a revision follows 5 minutes, and a later edit moves it back', async () => {
    vi.useFakeTimers();
    const repo = new FakeRevisionRepo();
    const clock = new FakeClock(1_700_000_000_000);
    const scheduler = createRevisionScheduler({ repo, clock, report: revisionReport(createCollabLog(new FakeLogger())) });
    repo.setPage(PAGE, { title: 'T', markdown: 'text' });
    scheduler.changed(PAGE, ANA);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    scheduler.changed(PAGE, ANA);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(repo.made(PAGE)).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await scheduler.whenIdle();
    expect(repo.made(PAGE)).toHaveLength(1);
  });
});

describe('a failure that is not an Error', () => {
  it('is logged with a fixed name, for a page and for the catch-up', async () => {
    const b = build();
    b.repo.setPage(PAGE, { title: 'T', markdown: 'text' });
    b.scheduler.changed(PAGE, ANA);
    b.repo.failNext = 'plain string' as unknown as Error;
    await b.scheduler.unloaded(PAGE);
    b.repo.failNext = 'plain string' as unknown as Error;
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.events('collab.revision_failed').map((e) => e.fields)).toEqual([{ pageId: PAGE, errorName: 'unknown' }, { pageId: 'catch-up', errorName: 'unknown' }]);
  });
});
