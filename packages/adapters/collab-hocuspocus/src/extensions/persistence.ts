import type { Extension, HookPayloadByName } from '@hocuspocus/server';
import type { CollabDeps } from '@tektum/grimoire-core/ports/collaboration-host';
import * as Y from 'yjs';
import type { CollabLog } from '../events.js';
import { readContext } from '../context.js';
import { createEditorTracker, editorColumn } from '../editors.js';
import { REFUSAL_CLOSE_CODES, Refusal, codeFor } from '../refusal.js';
import type { RefusalTable } from '../refusal.js';
import { createConversionGate, createSaver, hashMarkdown, isBusy, reidentify } from '../save.js';
import type { BreakerOptions } from '../save.js';
import type { Conversion } from '../save.js';

/** Consecutive failures for one page after which `collab.store_alarm` is logged, once per streak. */
export const STORE_ALARM_AFTER = 5;

export interface PersistenceOptions {
  readonly deps: CollabDeps;
  /** The host's refusal table (the defaults and its overrides): the stale-epoch close uses the code the reconnect is refused with. */
  readonly refusals?: RefusalTable;
  readonly log: CollabLog;
  /** Waits `ms`, rejecting when `signal` aborts. Own seam because the Clock port has no timers; tests pass a fake. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Slot for the next milestone (page-change bookkeeping). Called after every document change; must not throw. */
  readonly onChange?: (e: { documentName: string }) => void;
  /** Conversions the converter runs at once: its worker count (default 1). The gate in front of it admits this many, no fewer, so that a slow page cannot make another wait while a worker is idle. */
  readonly convertConcurrency?: number;
  /** How long a conversion may wait for the converter before the save goes state-only as "busy" (default 10 s). */
  readonly convertWaitMs?: number;
  /** Later attempt at converting a page whose save was busy: first delay, cap and number of attempts (defaults 2 s, 30 s, 8). */
  readonly convertRetryBaseMs?: number;
  readonly convertRetryMaxMs?: number;
  readonly convertRetryLimit?: number;
  /** Per-page circuit breaker of the converter (see `createSaver`); defaults: 2 heavy failures, back-off 30 s x4 up to 30 min. */
  readonly breaker?: BreakerOptions;
}

export interface PersistenceExtension extends Extension {
  /** Stops every retry loop at once (sleeping ones wake up); the pages concerned stay in memory unsaved. Used when the shutdown deadline passes. */
  abandon(): void;
  /** Shutdown has started: no further "convert later" timers; the pending ones are cancelled (final saves convert at once or go state-only). */
  beginShutdown(): void;
  /** Pages with changes not yet stored. */
  unsavedPages(): string[];
  /** Pages any per-page bookkeeping still refers to (diagnostics and tests: 0 once every page has unloaded and its saves are done). */
  trackedPages(): number;
}

class Abandoned extends Error {
  constructor() { super(''); }
}

class SeedError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(''); this.reason = reason; }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);

export function createPersistenceExtension(o: PersistenceOptions): PersistenceExtension {
  const { pages } = o.deps;
  const { storeRetryBaseMs, storeRetryMaxMs } = o.deps.config.collab;
  const retryBaseMs = o.convertRetryBaseMs ?? 2000;
  const retryMaxMs = o.convertRetryMaxMs ?? 30_000;
  const retryLimit = o.convertRetryLimit ?? 8;
  const converter = createConversionGate(o.deps.converter, { ...(o.convertConcurrency === undefined ? {} : { concurrency: o.convertConcurrency }), ...(o.convertWaitMs === undefined ? {} : { waitMs: o.convertWaitMs }) });
  const saver = createSaver({ converter, log: o.log, clock: () => o.deps.clock.now(), ...(o.breaker ? { breaker: o.breaker } : {}) });
  const editors = createEditorTracker();
  const failures = new Map<string, number>();
  // A page is unsaved while its change counter is ahead of the counter value a successful store started from; a store that hangs or
  // fails therefore leaves it unsaved, and an edit arriving during a store keeps it unsaved after that store succeeds.
  const changes = new Map<string, number>();
  const saved = new Map<string, number>();
  const alarmed = new Set<string>();
  const epochs = new Map<string, number>();
  /** The tenant each loaded page was loaded in: the first connection's, which admission checked against the page (docs/tenancy.md section 3.2). Saves run in it. */
  const tenants = new Map<string, string>();
  /** Pages whose save was refused (stale epoch or deleted row): never saved or logged again until the document unloads. */
  const epochRefused = new Set<string>();
  /** Pages with a save in progress, and those among them that unloaded meanwhile (their loaded epoch is gone: nothing may be written for them). */
  const savingNow = new Set<string>();
  const unloadedWhileSaving = new Set<string>();
  let instance: HookPayloadByName['onStoreDocument']['instance'] | undefined;
  const abort = new AbortController();
  // Saves of one page run one after the other, whoever starts them (Hocuspocus's store hook, which already holds a per-document mutex, or the
  // "convert later" timer below, which does not): each encodes the state when it starts, so an older conversion can never overwrite a newer one.
  const tails = new Map<string, Promise<void>>();
  const waiting = new Map<string, { document: Y.Doc; owner: object | undefined; done: Promise<{ busy: boolean }> }>();
  const serial = <T>(pageId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(pageId) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    tails.set(pageId, tail);
    void tail.then(() => { if (tails.get(pageId) === tail) tails.delete(pageId); });
    return run;
  };
  // "Convert later": a busy save stored the state without the Markdown. Nothing else would convert a page nobody edits again, so one timer per page
  // (cancelled by any save of that page, by unloading and by shutdown) tries again with backoff, a bounded number of times; the final save at unload tries once more.
  const timers = new Map<string, AbortController>();
  const busyAttempts = new Map<string, number>();
  let draining = false;
  // One token per load of a page, removed when the page unloads (so the map holds the loaded pages only): a timer, or a save started on a timer,
  // belongs to the token it was started under and does nothing once that is gone or replaced (nothing may be scheduled or saved for a page that is
  // no longer loaded, nor, once shutdown has begun, by a timer; the final saves of shutdown go through Hocuspocus).
  const loads = new Map<string, object>();
  const gen = (pageId: string): object | undefined => loads.get(pageId);
  const genFor = (pageId: string): object => { let t = loads.get(pageId); if (t === undefined) { t = {}; loads.set(pageId, t); } return t; };
  // Pages loaded with stale Markdown: converted once after the load (`afterLoadDocument`); a refusal is not retried until the next load.
  const staleOnLoad = new Set<string>();
  // Seeds the converter refused, by the hash of the Markdown that was refused: the same Markdown is refused again without converting (bounded, oldest out).
  const seedRefused = new Map<string, string>();
  const SEED_REFUSED_MAX = 1000;

  let loadFailures = 0;
  let lastLoadReport = Number.NEGATIVE_INFINITY;
  let loadReportsHeldBack = 0;
  /** At most one `collab.load_failed` per 10 s (the injected clock), carrying how many were held back: an outage must not flood the log. */
  const reportLoadFailure = (e: unknown, consecutive: number): void => {
    if (o.deps.clock.now() - lastLoadReport < 10_000) { loadReportsHeldBack += 1; return; }
    lastLoadReport = o.deps.clock.now();
    o.log.emit('collab.load_failed', { errorName: e instanceof Error ? e.name : 'NonError', consecutive, suppressed: loadReportsHeldBack });
    loadReportsHeldBack = 0;
  };

  const cancelTimer = (pageId: string): void => { timers.get(pageId)?.abort(); timers.delete(pageId); };

  /** One page save: encode, convert, write. Throws on a database error (after restoring the editor record). Returns whether the conversion was busy. */
  const saveLoop = async (pageId: string, document: Y.Doc): Promise<{ busy: boolean }> => {
    savingNow.add(pageId);
    unloadedWhileSaving.delete(pageId);
    try { return await saveLoopBody(pageId, document); } finally { savingNow.delete(pageId); unloadedWhileSaving.delete(pageId); }
  };
  const saveLoopBody = async (pageId: string, document: Y.Doc): Promise<{ busy: boolean }> => {
    cancelTimer(pageId);
    let cache: { state: Uint8Array; conversion: Conversion } | undefined;
    for (let attempt = 1; ; attempt++) {
      if (abort.signal.aborted) throw new Abandoned();
      const version = changes.get(pageId) ?? 0;
      const record = editors.take(pageId);
      let conversion: Conversion | undefined;
      try {
        // Encoded on every attempt, so edits made while the database was down are in the state that finally lands.
        const state = Y.encodeStateAsUpdate(document);
        // A database retry of unchanged state reuses its conversion: a failed one is neither logged nor counted twice.
        if (cache === undefined || !sameBytes(cache.state, state)) cache = { state, conversion: await saver.convert(pageId, state) };
        conversion = cache.conversion;
        // The page can have been unloaded while the conversion ran (every client left): its loaded epoch is gone, and a write with a made-up
        // epoch 0 could be refused as a mismatch and then mark the NEXT load of the page refused. Nothing is written for an unloaded page.
        if (unloadedWhileSaving.has(pageId)) return { busy: false }; // the record is dropped with the page: restoring it would leak the old session's editor into the next load
        if (abort.signal.aborted) throw new Abandoned(); // shutdown gave up while the conversion ran: no database write after the deadline
        const write = saver.toWrite(conversion, {
          state, epoch: epochs.get(pageId) ?? 0, editedBy: editorColumn(record?.latest), editedAt: record?.at ?? o.deps.clock.now(),
        });
        const started = performance.now();
        const outcome = await pages.store(tenants.get(pageId) ?? 'legacy', pageId, write);
        if (unloadedWhileSaving.has(pageId)) return { busy: false }; // the page unloaded during the write: nothing is recorded or logged for a page that is gone
        if (outcome.written && conversion.ok) {
          busyAttempts.delete(pageId);
          o.log.emit('collab.saved', {
            pageId, stateBytes: state.byteLength, markdownBytes: Buffer.byteLength(conversion.markdown, 'utf8'),
            convertMs: conversion.convertMs, writeMs: Math.round(performance.now() - started),
          });
        } else if (!outcome.written && outcome.reason === 'unchanged') {
          o.log.emit('collab.save_skipped', { pageId });
        } else if (record !== undefined && outcome.written) {
          editors.restore(pageId, record); // state-only: the editor is not stored yet, the later conversion stores it
        }
        if (!outcome.written && (outcome.reason === 'epoch-mismatch' || outcome.reason === 'no-row')) {
          // Nothing was written and nothing is retried: the clients reload (closing the last connection unloads the document, so the next open loads the new epoch).
          epochRefused.add(pageId);
          cancelTimer(pageId);
          o.log.emit('collab.save_refused_epoch', { pageId, loaded: epochs.get(pageId) ?? 0, reason: outcome.reason });
          // The clients see the stale-epoch close (4409), the code a reconnect with the old epoch is refused with, so they reload instead of retrying.
          for (const c of instance?.documents.get(pageId)?.getConnections() ?? []) c.close({ code: codeFor(o.refusals ?? REFUSAL_CLOSE_CODES, 'stale-epoch'), reason: 'stale-epoch' });
        }
        saved.set(pageId, version);
        failures.delete(pageId);
        if (alarmed.delete(pageId)) o.log.emit('collab.store_recovered', { pageId });
        return { busy: !conversion.ok && conversion.busy };
      } catch (e) {
        if (e instanceof Abandoned) throw e;
        if (unloadedWhileSaving.has(pageId)) return { busy: false }; // the page is gone: no editor record, failure streak or retry for it
        if (record !== undefined) editors.restore(pageId, record);
        const consecutive = (failures.get(pageId) ?? 0) + 1;
        failures.set(pageId, consecutive);
        const retryInMs = Math.min(storeRetryBaseMs * 2 ** (consecutive - 1), storeRetryMaxMs);
        o.log.emit('collab.store_failed', { pageId, attempt, consecutive, retryInMs, errorName: e instanceof Error ? e.name : 'NonError' });
        if (consecutive === STORE_ALARM_AFTER) { alarmed.add(pageId); o.log.emit('collab.store_alarm', { pageId, consecutive }); }
        if (abort.signal.aborted) throw new Abandoned();
        try {
          await o.sleep(retryInMs, abort.signal);
        } catch {
          throw new Abandoned();
        }
      }
    }
  };

  const convertLater = (pageId: string, document: Y.Doc, g: object): void => {
    if (draining || abort.signal.aborted || gen(pageId) !== g) return;
    const attempt = (busyAttempts.get(pageId) ?? 0) + 1;
    if (attempt > retryLimit) return;
    busyAttempts.set(pageId, attempt);
    const inMs = Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs);
    const timer = new AbortController();
    timers.set(pageId, timer);
    o.sleep(inMs, timer.signal).then(() => {
      if (timers.get(pageId) !== timer) return;
      timers.delete(pageId);
      if (draining || gen(pageId) !== g) return;
      o.log.emit('collab.convert_retry', { pageId, attempt, inMs });
      return run(pageId, document, g);
    }).catch(() => undefined); // cancelled or abandoned: nothing to report, the page is stale in memory and the final save tries again
  };

  /** `owner`: the load generation a timer-started save belongs to; such a save is dropped when the page has unloaded or shutdown has begun. */
  const run = async (pageId: string, document: Y.Doc, owner?: object): Promise<void> => {
    const g = owner ?? genFor(pageId);
    // At most one save of a page WAITS behind the running one (the slot is per page, not per owner: a timer-started save, which has an owner, never waits
    // beside the page's own saves, because every save that starts cancels the page's retry timer and a timer is only set when a save ends): a save that arrives while another already waits joins it (they share the answer),
    // because the waiting save encodes the state when it starts, so it already holds everything the joiner would have saved. Without this the saves
    // of a page queue one behind the other and each runs its own conversion, however slow the conversion is (the saver's own single flight never
    // sees two at once, as this queue starts them one at a time).
    const queued = waiting.get(pageId);
    if (queued !== undefined && queued.document === document && queued.owner === owner) { await queued.done; return; }
    const entry: { document: Y.Doc; owner: object | undefined; done: Promise<{ busy: boolean }> } = {
      document, owner,
      done: serial(pageId, () => {
        if (waiting.get(pageId) === entry) waiting.delete(pageId); // it starts now: a later save is a new waiting one
        return owner !== undefined && (draining || gen(pageId) !== owner) ? Promise.resolve({ busy: false }) : saveLoop(pageId, document);
      }),
    };
    waiting.set(pageId, entry);
    const { busy } = await entry.done;
    if (busy) convertLater(pageId, document, g);
  };

  return {
    extensionName: 'grimoire-persistence',
    priority: 100,

    async onLoadDocument(data: HookPayloadByName['onLoadDocument']): Promise<undefined> {
      const pageId = data.documentName;
      const tenantId = readContext(data.context).tenantId ?? 'legacy';
      let stored;
      try {
        stored = await pages.load(tenantId, pageId);
        loadFailures = 0;
      } catch (e) {
        // One streak for the whole process, not per page: a name a client makes up cannot grow a map during an outage.
        loadFailures += 1;
        reportLoadFailure(e, loadFailures);
        if (loadFailures === STORE_ALARM_AFTER) o.log.emit('collab.load_alarm', { consecutive: loadFailures });
        throw new Refusal('try-again');
      }
      if (stored === undefined) throw new Refusal('not-found');
      let { state, epoch } = stored;
      if (state === null && stored.markdown !== null && stored.markdown !== '') {
        const refused = seedRefused.get(pageId);
        if (refused !== undefined && refused === Buffer.from(hashMarkdown(stored.markdown)).toString('hex')) {
          o.log.emit('collab.seed_failed', { pageId, reason: 'refused-before' }); // throttled by the host's log; nothing is converted again
          throw new Refusal('seed-failed');
        }
        seedRefused.delete(pageId); // the Markdown changed since the refusal
      }
      if (state === null) {
        // The row has no state: seed it from its Markdown, if it has any, under the row lock (one seed however many clients open the page at once).
        const started = performance.now();
        let failure: { reason: string; busy: boolean } | undefined;
        try {
          // `reseed` TRUSTS this Markdown (our own serialiser's, lenient limits). A row with Markdown and no state must never hold user-supplied text:
          // user Markdown goes through `seed` and is stored as state (spec R7.13).
          const seeded = await pages.seed(tenantId, pageId, async (markdown) => {
            const r = await converter.reseed(markdown, pageId);
            if (!r.ok) { failure = { reason: r.reason, busy: isBusy(r.reason, r.detail) }; throw new SeedError(r.reason); }
            return reidentify(r.state, pageId, markdown);
          });
          ({ state, epoch } = seeded);
          if (seeded.seeded && state !== null) o.log.emit('collab.seed', { pageId, bytes: state.byteLength, ms: Math.round(performance.now() - started) });
        } catch {
          if (failure === undefined) throw new Refusal('try-again'); // the database, not the conversion
          o.log.emit('collab.seed_failed', { pageId, reason: failure.reason });
          // Remembered only when the converter refused the Markdown ITSELF: a worker crash, a timeout or a closing pool says nothing about the page,
          // and would otherwise lock every later open out until someone edited it.
          if (['invalid-markdown', 'too-large'].includes(failure.reason) && stored.markdown !== null) {
            if (seedRefused.size >= SEED_REFUSED_MAX) seedRefused.delete(seedRefused.keys().next().value ?? pageId);
            seedRefused.set(pageId, Buffer.from(hashMarkdown(stored.markdown)).toString('hex'));
          }
          // 'seed-failed' tells the client not to reconnect because the refusal repeats until the Markdown changes: true only for a refusal of the Markdown itself.
          throw new Refusal(['invalid-markdown', 'too-large'].includes(failure.reason) ? 'seed-failed' : 'try-again');
        }
      }
      epochs.set(pageId, epoch);
      tenants.set(pageId, tenantId);
      staleOnLoad.delete(pageId); // a marker left by an earlier load that failed half way must not make this load look stale
      epochRefused.delete(pageId); // a fresh load starts without an earlier load's refusal
      if (stored.markdownStaleSince !== null) staleOnLoad.add(pageId);
      if (state === null) return undefined;
      // Applied here rather than returned, so unreadable stored state is a refusal of this page and not an error inside the library.
      try {
        Y.applyUpdate(data.document, state);
      } catch {
        throw new Refusal('state-corrupt');
      }
      return undefined;
    },

    // Hocuspocus logs a failed store and never retries it; retrying with backoff is ours. It never gives up while the document is loaded
    // (the contract has no retry limit: the alarm stays raised), only at the shutdown deadline.
    // A page that opens with stale Markdown is converted once, without an edit. A busy converter is retried by the timer; a refusal waits for the next load.
    async afterLoadDocument(data: HookPayloadByName['afterLoadDocument']): Promise<void> {
      instance = data.instance;
      if (!staleOnLoad.delete(data.documentName) || draining) return;
      // Rejects only with `Abandoned` (shutdown deadline): every other failure is retried inside the save loop and logged there.
      void run(data.documentName, data.document, genFor(data.documentName)).catch(() => undefined);
    },

    async onStoreDocument(data: HookPayloadByName['onStoreDocument']): Promise<void> {
      instance = data.instance;
      if (epochRefused.has(data.documentName)) return;
      await run(data.documentName, data.document);
    },

    async onChange(data: HookPayloadByName['onChange']): Promise<void> {
      changes.set(data.documentName, (changes.get(data.documentName) ?? 0) + 1);
      editors.record(data.documentName, readContext(data.context).userId, o.deps.clock.now());
      try { o.onChange?.({ documentName: data.documentName }); } catch { /* not awaited by Hocuspocus: a throw would be an unhandled rejection */ }
    },

    async afterUnloadDocument(data: HookPayloadByName['afterUnloadDocument']): Promise<void> {
      const pageId = data.documentName;
      for (const m of [failures, changes, saved, epochs, tenants, busyAttempts]) m.delete(pageId);
      alarmed.delete(pageId);
      epochRefused.delete(pageId);
      if (savingNow.has(pageId)) unloadedWhileSaving.add(pageId);
      loads.delete(pageId);
      staleOnLoad.delete(pageId);
      cancelTimer(pageId);
      editors.forget(pageId);
      saver.forget(pageId);
    },

    abandon(): void { abort.abort(); for (const id of [...timers.keys()]) cancelTimer(id); },
    beginShutdown(): void { draining = true; for (const id of [...timers.keys()]) cancelTimer(id); },
    trackedPages(): number { return new Set([...failures.keys(), ...changes.keys(), ...saved.keys(), ...epochs.keys(), ...epochRefused, ...busyAttempts.keys(), ...loads.keys(), ...timers.keys(), ...tails.keys(), ...alarmed]).size; },
    unsavedPages(): string[] { return [...changes].filter(([id, n]) => n > (saved.get(id) ?? 0)).map(([id]) => id); },
  };
}
