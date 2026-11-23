import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { PageRevisionResult, RevisionRepo } from '@tektum/grimoire-core/ports/revision-repo';
import { editorColumn } from '../editors.js';

/** Revisions after this long without an edit (R9.2). */
export const IDLE_MS = 5 * 60 * 1000;
/** After a failed catch-up the next page open tries again, but not sooner than this. */
export const CATCH_UP_RETRY_MS = 60 * 1000;
/** Pages the catch-up after a restart handles per statement. */
export const CATCH_UP_BATCH = 500;

/** The timers the scheduler uses; tests pass fake ones. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The global timers, unref'd: a revision timer is background work and must never be the reason the process stays alive. */
const globalTimers: Timers = {
  setTimeout: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref(); return handle; },
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

type Reason = 'idle' | 'last_editor_left';

/** What the scheduler reports; the extension turns each into its log event (counts and ids only). */
export interface SchedulerReport {
  created(pageId: string, reason: Reason): void;
  /** The saved Markdown was stale: one report per deferral. */
  deferred(pageId: string): void;
  /** `pageId` is `catch-up` for the restart catch-up. */
  failed(pageId: string, errorName: string): void;
}

/** What has happened to a page since its last revision. */
interface Pending {
  /** Each author with the version of their latest change: a revision takes the authors up to the version it was made from. */
  readonly authors: Map<string, number>;
  latest: string | undefined;
  /** Counts the changes: an edit that arrives while a revision is being made is newer than what that revision read. */
  version: number;
  lastEditAt: number;
  timer: unknown;
  /** A revision that could not be made yet because the saved Markdown was stale: made at the next save that clears the flag. */
  deferred: Reason | undefined;
}

export interface SchedulerOptions {
  readonly repo: RevisionRepo;
  readonly clock: Clock;
  readonly report: SchedulerReport;
  readonly timers?: Timers;
  readonly idleMs?: number;
}

export interface RevisionScheduler {
  /** A change arrived on the page from `userId` (undefined: no known user). Restarts the page's 5-minute timer. */
  changed(pageId: string, userId: string | undefined): void;
  /** A save of the page finished: a deferred revision is tried again. */
  saved(pageId: string): Promise<void>;
  /** The page was unloaded (its last connection left and its last save is done): the last editor left. */
  unloaded(pageId: string): Promise<void>;
  /** A page was opened. The first time since the start, the revisions a restart lost are made; until then there is no database work. */
  opened(): void;
  /** Resolves when no revision work is running (for tests and shutdown). */
  whenIdle(): Promise<void>;
  /** The shutdown begins: cancels every timer and starts no more work. Final. */
  stop(): void;
}

/**
 * The rules of R9.2 and R9.3, apart from Hocuspocus: a timer per edited page, the last editor leaving, the catch-up after a restart. A
 * page nobody changed has no state here and costs nothing; a revision is made from the page's SAVED state by the repository, which skips
 * identical content and refuses stale Markdown.
 */
export function createRevisionScheduler(o: SchedulerOptions): RevisionScheduler {
  const timers = o.timers ?? globalTimers;
  const idleMs = o.idleMs ?? IDLE_MS;
  const pending = new Map<string, Pending>();
  const inFlight = new Set<Promise<void>>();
  const tails = new Map<string, Promise<void>>();
  let caughtUp = false;
  /** Set at the start of the shutdown: no new timer, no new database work. What was owed is made by the catch-up after the restart. */
  let stopped = false;
  let retryAfter = 0;
  let catchUpTimer: unknown;

  const track = (p: Promise<void>): Promise<void> => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };

  /** Page by page, one at a time: a timer and an unload of the same page never write two revisions of one state. */
  const serial = (pageId: string, work: () => Promise<void>): Promise<void> => {
    const run = (tails.get(pageId) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => undefined);
    tails.set(pageId, settled);
    void settled.then(() => { if (tails.get(pageId) === settled) tails.delete(pageId); });
    return track(settled);
  };

  /** Edits that arrived after `seen` are not covered by what the repository read: they stay owed, with a timer, and the authors already in the revision go. */
  const settle = (pageId: string, state: Pending, seen: number): void => {
    if (state.version === seen) { pending.delete(pageId); return; }
    for (const [author, version] of state.authors) if (version <= seen) state.authors.delete(author);
    state.deferred = undefined;
  };

  const outcome = (pageId: string, reason: Reason, state: Pending, seen: number, result: PageRevisionResult): void => {
    if (result.kind === 'created') {
      settle(pageId, state, seen);
      o.report.created(pageId, reason);
    } else if (result.kind === 'stale') {
      // One event per deferral, not one per attempt.
      if (state.deferred === undefined) o.report.deferred(pageId);
      state.deferred = reason;
    } else {
      // Identical to the latest revision, no Markdown yet, or no page: nothing is owed for the edits the repository saw.
      settle(pageId, state, seen);
    }
  };

  const attempt = (pageId: string, reason: Reason): Promise<void> =>
    serial(pageId, async () => {
      const state = pending.get(pageId);
      if (state === undefined || stopped) return;
      timers.clearTimeout(state.timer);
      state.timer = undefined;
      const seen = state.version;
      const authorIds = [...state.authors.keys()];
      const lastAuthorId = state.latest ?? null;
      const at = state.lastEditAt;
      try {
        const result = await o.repo.createFromPage({
          pageId, reason, authorIds, lastAuthorId, at,
        });
        outcome(pageId, reason, state, seen, result);
      } catch (error) {
        // The edits stay owed: the next trigger tries again.
        o.report.failed(pageId, error instanceof Error ? error.name : 'unknown');
      }
    });

  return {
    changed(pageId, userId) {
      if (stopped) return;
      const at = o.clock.now();
      const state = pending.get(pageId) ?? { authors: new Map<string, number>(), latest: undefined, version: 0, lastEditAt: at, timer: undefined, deferred: undefined };
      state.version += 1;
      const editor = editorColumn(userId);
      if (editor !== undefined) state.authors.set(editor, state.version);
      state.latest = editor;
      state.lastEditAt = at;
      timers.clearTimeout(state.timer);
      state.timer = timers.setTimeout(() => { void attempt(pageId, 'idle'); }, idleMs);
      pending.set(pageId, state);
    },
    saved(pageId) {
      const reason = pending.get(pageId)?.deferred;
      return reason === undefined ? Promise.resolve() : attempt(pageId, reason);
    },
    unloaded(pageId) {
      return pending.has(pageId) ? attempt(pageId, 'last_editor_left') : Promise.resolve();
    },
    opened() {
      if (stopped || caughtUp || o.clock.now() < retryAfter) return;
      caughtUp = true;
      const run = async (): Promise<boolean> => {
        try {
          for (;;) {
            const made = await o.repo.catchUp(o.clock.now() - idleMs, CATCH_UP_BATCH);
            for (const m of made) o.report.created(m.pageId, 'idle');
            if (made.length < CATCH_UP_BATCH) return true;
          }
        } catch (error) {
          o.report.failed('catch-up', error instanceof Error ? error.name : 'unknown');
          return false;
        }
      };
      void track((async () => {
        if (!(await run())) {
          // The next page open tries again, after a pause.
          caughtUp = false;
          retryAfter = o.clock.now() + CATCH_UP_RETRY_MS;
          return;
        }
        // Pages saved less than 5 minutes before the restart had no timer in this process: one more pass, when they have been quiet that long.
        if (stopped) return;
        catchUpTimer = timers.setTimeout(() => { void track(run().then(() => undefined)); }, idleMs);
      })());
    },
    whenIdle: async () => { while (inFlight.size > 0) await Promise.all([...inFlight]); },
    stop() {
      stopped = true;
      for (const state of pending.values()) timers.clearTimeout(state.timer);
      timers.clearTimeout(catchUpTimer);
    },
  };
}
