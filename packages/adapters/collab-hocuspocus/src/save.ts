import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type { PageWrite } from '@tektum/grimoire-core/ports/collaboration-host';
import type { ConvertFailure, ConvertResult, MarkdownConverter, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import type { CollabLog } from './events.js';

/** Fixed detail of the gate's own "no room" timeout; the pool never produces it, so a pool `timeout` is always a run that exceeded its limit. */
export const WAITING_DETAIL = 'waiting-for-converter';
/** How long a call may wait for the converter before it is answered "busy" (the pool's own default timeout). */
export const DEFAULT_CONVERT_WAIT_MS = 10_000;

/**
 * "Busy", not "broken": the converter had no room for this call. The state is still stored and the page converted on a later save; nothing here
 * counts toward `collab.convert_alarm`. Everything else that is not ok is a real failure (refusal, `invalid-state`, a run past its limit, out of memory).
 */
export function isBusy(reason: ConvertFailure | string, detail: string): boolean {
  if (reason === 'timeout') return detail === WAITING_DETAIL;
  return reason === 'internal' && (detail === 'queue-full' || detail === 'closed');
}

export interface ConversionGate extends MarkdownConverter {
  /** `low`: a probe of a page whose breaker is open; it is admitted only when no ordinary call is waiting. */
  toMarkdown(state: Uint8Array, o?: { low?: boolean }): Promise<ConvertResult>;
  /** Calls waiting for a free slot, for tests and diagnostics. */
  waiting(): number;
}

/**
 * Admits at most `concurrency` calls into the converter, in submission order, each waiting at most `waitMs`. Hand-written because the pool's single
 * timeout covers queue wait and run and reports both as `timeout`, so a caller cannot tell "the pool was busy" from "this conversion ran too long"
 * (verification finding 1), and because the pool does not complete queued calls in submission order (finding 4). Admitted calls find the pool idle,
 * so a `timeout` the pool reports afterwards is a run. `concurrency` must equal the pool size (1 by contract). The wait timer is a normal ref'd
 * timer: it also keeps the event loop alive while a shutdown waits on a conversion.
 */
export function createConversionGate(inner: MarkdownConverter, o: { concurrency?: number; waitMs?: number } = {}): ConversionGate {
  const concurrency = o.concurrency ?? 1;
  const waitMs = o.waitMs ?? DEFAULT_CONVERT_WAIT_MS;
  let active = 0;
  const queue: { admit: () => void; drop: () => void; low: boolean }[] = [];

  const acquire = (low: boolean): Promise<boolean> => {
    if (active < concurrency) { active++; return Promise.resolve(true); }
    return new Promise<boolean>((resolve) => {
      const entry = {
        low,
        admit: () => { clearTimeout(timer); queue.splice(queue.indexOf(entry), 1); active++; resolve(true); },
        drop: () => { queue.splice(queue.indexOf(entry), 1); resolve(false); },
      };
      const timer = setTimeout(() => { entry.drop(); }, waitMs);
      queue.push(entry);
    });
  };
  // Ordinary calls first, in submission order; a probe of a broken page goes only when nobody else waits (it can never run ahead of other pages).
  const release = (): void => { active--; (queue.find((e) => !e.low) ?? queue[0])?.admit(); };

  const run = async <R>(call: () => Promise<R>, busy: R, failed: R, low = false): Promise<R> => {
    if (!(await acquire(low))) return busy;
    try {
      return await call();
    } catch {
      return failed; // the port never rejects; a converter that does is still a typed failure
    } finally {
      release();
    }
  };
  const busyConvert: ConvertResult = { ok: false, reason: 'timeout', detail: WAITING_DETAIL };
  const busySeed: SeedResult = { ok: false, reason: 'timeout', detail: WAITING_DETAIL };
  const failedConvert: ConvertResult = { ok: false, reason: 'internal', detail: 'worker-failed' };
  const failedSeed: SeedResult = { ok: false, reason: 'internal', detail: 'worker-failed' };
  return {
    toMarkdown: (state, opts) => run(() => inner.toMarkdown(state), busyConvert, failedConvert, opts?.low === true),
    seed: (markdown) => run(() => inner.seed(markdown), busySeed, failedSeed),
    close: () => inner.close(),
    waiting: () => queue.length,
  };
}

/** Identifies one Markdown text (the key of a refused seed). Not the stored `markdown_hash`: the page store computes that from title and Markdown (R4.21). */
export const hashMarkdown = (markdown: string): Uint8Array => new Uint8Array(createHash('sha256').update(markdown, 'utf8').digest());

/**
 * A seed state carries the identity (Yjs client id) of whoever built it. The converter uses one fixed id, so two seeds of different Markdown would share
 * an identity and clock and corrupt stale clients (review F5). The content is copied into a document whose id derives from the page and the Markdown: the
 * same page and Markdown always give the same bytes (servers seeding the same row agree), different Markdown never shares an id.
 */
export function reidentify(state: Uint8Array, pageId: string, markdown: string, fragmentName = 'prosemirror'): Uint8Array {
  const source = new Y.Doc();
  Y.applyUpdate(source, state);
  const target = new Y.Doc();
  const digest = createHash('sha256').update(pageId, 'utf8').update('\0').update(markdown, 'utf8').digest();
  const id = digest.readUInt32BE(0);
  target.clientID = id === 3_000_000_000 ? id ^ 1 : id;
  const from = source.getXmlFragment(fragmentName);
  target.getXmlFragment(fragmentName).insert(0, from.toArray().flatMap((n) => (n instanceof Y.XmlHook ? [] : [n.clone()])));
  return Y.encodeStateAsUpdate(target);
}

export type Conversion =
  | { ok: true; markdown: string; text: string; convertMs: number }
  | { ok: false; busy: boolean; reason: string };

export interface Saver {
  /** Converts a copy of `state` (the caller keeps its own for the database), logs and counts failures. Never rejects. */
  convert(pageId: string, state: Uint8Array): Promise<Conversion>;
  /** The write for a conversion. */
  toWrite(c: Conversion, o: { state: Uint8Array; epoch: number; editedBy: string | undefined; editedAt: number }): PageWrite;
  forget(pageId: string): void;
}

export interface BreakerOptions {
  /** Consecutive out-of-memory or dead-worker failures after which a page's conversions stop (a timeout while running opens it at once). */
  after?: number;
  /** First back-off, multiplied by `factor` at each further opening, up to `maxMs`. */
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  /** A page whose state shrank below this fraction of its size at the last failure is tried again at once. */
  shrinkTo?: number;
  /** TEST FACILITY ONLY: never open the breaker, to prove that a scenario fails without it. Set only by packages/adapters/config-env/src/test-facilities.ts (local mode). */
  disabled?: boolean;
}
interface Breaker { heavy: number; open: boolean; opened: number; openUntil: number; size: number }

export function createSaver(o: { converter: ConversionGate; log: CollabLog; now?: () => number; clock?: () => number; breaker?: BreakerOptions }): Saver {
  const now = o.now ?? (() => performance.now());
  const clock = o.clock ?? (() => Date.now());
  const after = o.breaker?.after ?? 2;
  const baseMs = o.breaker?.baseMs ?? 30_000;
  const factor = o.breaker?.factor ?? 4;
  const maxMs = o.breaker?.maxMs ?? 1_800_000;
  const shrinkTo = o.breaker?.shrinkTo ?? 0.75;
  // Per page, kept across unloads (a page that comes back is as heavy as it was); only pages with a failure are held. A restart resets it.
  const breakers = new Map<string, Breaker>();
  const BREAKERS_MAX = 1000;
  /** Consecutive real failures per page; the alarm is raised on the first of a streak. Busy outcomes neither extend nor end a streak. */
  const streak = new Map<string, number>();

  return {
    async convert(pageId, state) {
      const b = breakers.get(pageId);
      let probe = false;
      if (b?.open) {
        if (clock() < b.openUntil && state.byteLength > b.size * shrinkTo) return { ok: false, busy: false, reason: 'breaker-open' }; // state is stored, nothing converted
        probe = true;
      }
      const started = now();
      const r = await o.converter.toMarkdown(state.slice(), { low: probe });
      const closeBreaker = (): void => {
        if (b?.open) o.log.emit('collab.convert_breaker_closed', { pageId });
        breakers.delete(pageId);
      };
      if (r.ok) {
        closeBreaker();
        streak.delete(pageId);
        return { ok: true, markdown: r.markdown, text: r.text, convertMs: Math.round(now() - started) };
      }
      const busy = isBusy(r.reason, r.detail);
      const heavy = !busy && (r.reason === 'timeout' || r.reason === 'out-of-memory' || r.reason === 'internal');
      if (!busy && !heavy) closeBreaker(); // a cheap refusal: the worker is not being held
      if (heavy && o.breaker?.disabled !== true) {
        if (breakers.size >= BREAKERS_MAX && !breakers.has(pageId)) breakers.delete(breakers.keys().next().value ?? pageId);
        const cur = b ?? { heavy: 0, open: false, opened: 0, openUntil: 0, size: 0 };
        cur.heavy += 1;
        cur.size = state.byteLength;
        // One timeout while running is enough (a page needing more than the 10 s limit is beyond what the product supports, and each costs the single worker 10 s);
        // out-of-memory and a dead worker need `after` (2): they can follow a one-off memory spike of another page's work.
        if (cur.open || r.reason === 'timeout' || cur.heavy >= after) {
          const wasOpen = cur.open;
          cur.open = true;
          cur.opened += 1;
          const backoff = Math.min(baseMs * factor ** (cur.opened - 1), maxMs);
          cur.openUntil = clock() + backoff;
          if (!wasOpen) o.log.emit('collab.convert_breaker_open', { pageId, failures: cur.heavy, backoffMs: backoff });
        }
        breakers.set(pageId, cur);
      }
      o.log.emit('collab.convert_failed', { pageId, kind: busy ? 'busy' : 'broken', reason: r.reason, detail: r.detail });
      if (!busy) {
        const n = (streak.get(pageId) ?? 0) + 1;
        streak.set(pageId, n);
        if (n === 1) o.log.emit('collab.convert_alarm', { pageId, reason: r.reason });
      }
      return { ok: false, busy, reason: r.reason };
    },
    toWrite(c, w) {
      if (!c.ok) return { kind: 'state-only', state: w.state, epoch: w.epoch };
      return {
        kind: 'converted', state: w.state, markdown: c.markdown, text: c.text, epoch: w.epoch, editedAt: w.editedAt,
        ...(w.editedBy !== undefined ? { editedBy: w.editedBy } : {}),
      };
    },
    forget: (pageId) => { streak.delete(pageId); },
  };
}
