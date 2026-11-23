import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { createCollabLog } from '../../src/events.js';
import { revisionReport } from '../../src/extensions/revisions.js';
import { CATCH_UP_BATCH, createRevisionScheduler } from '../../src/revisions/scheduler.js';
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

describe('an edit that arrives while a revision is being made', () => {
  it('is not lost: it keeps its timer and makes its own revision, with only its own authors', async () => {
    const b = build();
    saved(b, 'before');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = b.repo.createFromPage.bind(b.repo);
    b.repo.createFromPage = async (request) => { const result = await original(request); await gate; return result; };
    b.scheduler.changed(PAGE, ANA);
    const firstEditAt = b.clock.now();
    b.timers.advance(5 * MINUTE);
    await vi.waitFor(() => { expect(b.repo.calls).toHaveLength(1); }); // the first revision read 'before' and waits at the gate
    saved(b, 'after');
    b.scheduler.changed(PAGE, BOB); // arrives while the first revision is still being written
    release();
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ markdown: 'before', authors: [ANA], createdAt: firstEditAt })]);
    expect(b.timers.pending).toBe(1);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE).map((r) => [r.markdown, r.authors])).toEqual([['before', [ANA]], ['after', [BOB]]]);
  });

  it('is still owed when the page unloads before its timer: the last editor leaving makes the revision', async () => {
    const b = build();
    saved(b, 'before');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = b.repo.createFromPage.bind(b.repo);
    b.repo.createFromPage = async (request) => { const result = await original(request); await gate; return result; };
    b.scheduler.changed(PAGE, ANA);
    b.timers.advance(5 * MINUTE);
    await vi.waitFor(() => { expect(b.repo.calls).toHaveLength(1); });
    saved(b, 'after');
    b.scheduler.changed(PAGE, ANA);
    release();
    await b.scheduler.whenIdle();
    await b.scheduler.unloaded(PAGE);
    expect(b.repo.made(PAGE).map((r) => [r.reason, r.markdown])).toEqual([['idle', 'before'], ['last_editor_left', 'after']]);
  });
});

describe('a save that lands while the revision is being made', () => {
  it('dates the revision at that save and names its editor, so the new Markdown is not credited to an earlier edit', async () => {
    const b = build();
    b.repo.setPage(PAGE, { title: 'T', markdown: 'with the later save', lastEditedAt: b.clock.now() + 5 * MINUTE + 10, lastEditedBy: BOB });
    b.scheduler.changed(PAGE, ANA);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ createdAt: b.clock.now() + 10, authors: [ANA, BOB], lastAuthorId: BOB })]);
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

describe('a failed attempt', () => {
  it('is tried again after another quiet period, so the idle rule does not die with it', async () => {
    const b = build();
    saved(b, 'text');
    b.scheduler.changed(PAGE, ANA);
    b.repo.failNext = new Error('database down');
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([]);
    expect(b.timers.pending).toBe(1);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ reason: 'idle', authors: [ANA] })]);
    expect(b.timers.pending).toBe(0);
  });

  it('arms no second timer when an edit already armed one, and none after the shutdown began', async () => {
    const b = build();
    saved(b, 'text');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    b.repo.createFromPage = async () => { entered += 1; await gate; throw new Error('database down'); };
    b.scheduler.changed(PAGE, ANA);
    b.timers.advance(5 * MINUTE);
    await vi.waitFor(() => { expect(entered).toBe(1); });
    b.scheduler.changed(PAGE, BOB);
    expect(b.timers.pending).toBe(1);
    release();
    await b.scheduler.whenIdle();
    expect(b.timers.pending).toBe(1);
    b.scheduler.stop();
    expect(b.timers.pending).toBe(0);

    const stopping = build();
    stopping.repo.setPage(PAGE, { title: 'T', markdown: 'text' });
    let open!: () => void;
    const hold = new Promise<void>((resolve) => { open = resolve; });
    let inside = 0;
    stopping.repo.createFromPage = async () => { inside += 1; await hold; throw new Error('database down'); };
    stopping.scheduler.changed(PAGE, ANA);
    stopping.timers.advance(5 * MINUTE);
    await vi.waitFor(() => { expect(inside).toBe(1); });
    stopping.scheduler.stop();
    open();
    await stopping.scheduler.whenIdle();
    expect(stopping.timers.pending).toBe(0);
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

  it('runs once more after 5 minutes for the pages saved just before the restart, which had no timer', async () => {
    const b = build();
    const recent = b.clock.now() - 3 * MINUTE;
    b.repo.setPage(PAGE, { title: 'T', markdown: 'saved just before the restart', lastEditedAt: recent, lastEditedBy: ANA });
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([]);
    expect(b.timers.pending).toBe(1);
    b.timers.advance(5 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ reason: 'idle', createdAt: recent })]);
    expect(b.repo.calls).toEqual(['catchUp', 'catchUp']);
    b.timers.advance(60 * MINUTE);
    await b.scheduler.whenIdle();
    expect(b.repo.calls).toEqual(['catchUp', 'catchUp']);
  });

  it('tries again at a later page open after a failure, but not at once', async () => {
    const b = build();
    b.repo.setPage(PAGE, { title: 'T', markdown: 'text', lastEditedAt: b.clock.now() - 6 * MINUTE, lastEditedBy: ANA });
    b.repo.failNext = new Error('database down');
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.events('collab.revision_failed')).toHaveLength(1);
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.repo.calls).toEqual(['catchUp']);
    b.timers.advance(60_000);
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.repo.calls).toEqual(['catchUp', 'catchUp']);
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ reason: 'idle' })]);
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

  it('retries a failed second pass at a later page open, after a pause', async () => {
    const b = build();
    b.repo.setPage(PAGE, { title: 'T', markdown: 'saved just before the restart', lastEditedAt: b.clock.now() - 3 * MINUTE, lastEditedBy: ANA });
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    b.repo.failNext = new Error('database down');
    b.timers.advance(5 * MINUTE); // the second pass runs and fails
    await b.scheduler.whenIdle();
    expect(b.events('collab.revision_failed')).toHaveLength(1);
    expect(b.repo.made(PAGE)).toEqual([]);
    b.scheduler.opened(); // inside the pause: nothing
    await b.scheduler.whenIdle();
    expect(b.repo.calls).toEqual(['catchUp', 'catchUp']);
    b.timers.advance(60_000);
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ reason: 'idle' })]);
  });

  it('works through more pages than one batch holds, and logs a failure without giving up the server', async () => {
    const b = build();
    for (let n = 0; n < CATCH_UP_BATCH + 1; n += 1) b.repo.setPage(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, { title: 'T', markdown: `m${String(n)}`, lastEditedAt: b.clock.now() - 6 * MINUTE - n, lastEditedBy: ANA });
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.events('collab.revision_created')).toHaveLength(CATCH_UP_BATCH + 1);
    expect(b.repo.calls).toEqual(['catchUp', 'catchUp']);
    const failing = build();
    failing.repo.failNext = new Error('database down');
    failing.scheduler.opened();
    await failing.scheduler.whenIdle();
    expect(failing.events('collab.revision_failed')).toEqual([expect.objectContaining({ fields: { pageId: 'catch-up', errorName: 'Error' } })]);
  });
});

describe('a revision owed at shutdown', () => {
  it('is not made by the shutdown, and the catch-up after the restart makes it exactly once', async () => {
    const b = build();
    const editedAt = b.clock.now();
    b.repo.setPage(PAGE, { title: 'T', markdown: 'saved at shutdown', lastEditedAt: editedAt, lastEditedBy: ANA });
    b.scheduler.changed(PAGE, ANA);
    b.scheduler.stop(); // the shutdown: timers cancelled, nothing waits for revision work
    await b.scheduler.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([]);
    expect(b.repo.calls).toEqual([]);

    // The server starts again, a few minutes later, with a new scheduler over the same stores; the first page open runs the catch-up.
    b.clock.advance(6 * MINUTE);
    const restarted = createRevisionScheduler({ repo: b.repo, clock: b.clock, report: revisionReport(createCollabLog(b.logger)), timers: b.timers });
    restarted.opened();
    await restarted.whenIdle();
    expect(b.repo.made(PAGE)).toEqual([expect.objectContaining({ reason: 'idle', createdAt: editedAt, markdown: 'saved at shutdown', authors: [ANA] })]);
    restarted.opened();
    b.timers.advance(10 * MINUTE);
    await restarted.whenIdle();
    expect(b.repo.made(PAGE)).toHaveLength(1);
    expect(b.events('collab.revision_created')).toHaveLength(1);
  });
});

describe('after the shutdown began', () => {
  it('starts no timer, no revision and no catch-up, and a catch-up pass that was running arms no second pass', async () => {
    const b = build();
    b.repo.setPage(PAGE, { title: 'T', markdown: 'text' });
    b.scheduler.changed(PAGE, ANA);
    b.scheduler.stop();
    b.scheduler.changed(PAGE, ANA);
    expect(b.timers.pending).toBe(0);
    await b.scheduler.unloaded(PAGE);
    await b.scheduler.saved(PAGE);
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.repo.calls).toEqual([]);

    const running = build();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const catchUp = running.repo.catchUp.bind(running.repo);
    running.repo.catchUp = async (before, limit) => { const made = await catchUp(before, limit); await gate; return made; };
    running.scheduler.opened();
    await vi.waitFor(() => { expect(running.repo.calls).toEqual(['catchUp']); });
    running.scheduler.stop();
    release();
    await running.scheduler.whenIdle();
    expect(running.timers.pending).toBe(0);
  });
});

describe('stopping leaves no timer behind, whatever was in flight', () => {
  it('clears the timer an edit armed while a revision was being written, and the catch-up\'s second pass, and any later call arms none', async () => {
    const b = build();
    b.repo.setPage(PAGE, { title: 'T', markdown: 'text' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = b.repo.createFromPage.bind(b.repo);
    b.repo.createFromPage = async (request) => { const result = await original(request); await gate; return result; };
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    b.scheduler.changed(PAGE, ANA);
    b.timers.advance(5 * MINUTE - 1);
    b.scheduler.changed(PAGE, BOB);
    b.timers.advance(5 * MINUTE); // the idle timer fires and the write waits at the gate
    await vi.waitFor(() => { expect(b.repo.calls.filter((c) => c.startsWith('createFromPage'))).toHaveLength(1); });
    b.scheduler.changed(PAGE, ANA); // arms a timer while the write is in flight
    expect(b.timers.pending).toBeGreaterThan(0);
    b.scheduler.stop();
    expect(b.timers.pending).toBe(0);
    release();
    await b.scheduler.whenIdle();
    b.scheduler.changed(PAGE, BOB);
    b.scheduler.opened();
    expect(b.timers.pending).toBe(0);
  });
});

describe('stopping', () => {
  it('cancels every timer, the catch-up\'s second pass included', async () => {
    const b = build();
    b.scheduler.changed(PAGE, ANA);
    b.scheduler.opened();
    await b.scheduler.whenIdle();
    expect(b.timers.pending).toBe(2);
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

describe('the default timers never hold the process open', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('are unref\'d: the handle the scheduler arms is not ref\'d', () => {
    const handles: { hasRef(): boolean }[] = [];
    vi.useFakeTimers();
    const scheduler = createRevisionScheduler({ repo: new FakeRevisionRepo(), clock: new FakeClock(1), report: revisionReport(createCollabLog(new FakeLogger())) });
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, ms?: number) => { const h = real(callback, ms); handles.push(h as unknown as { hasRef(): boolean }); return h; }) as typeof setTimeout;
    try { scheduler.changed(PAGE, ANA); } finally { globalThis.setTimeout = real; }
    expect(handles).toHaveLength(1);
    expect(handles[0]?.hasRef()).toBe(false);
    scheduler.stop();
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
