import { fileURLToPath } from 'node:url';
import Piscina from 'piscina';
import type {
  ConvertFailure,
  ConvertResult,
  MarkdownConverter,
  SeedFailure,
  SeedResult,
} from '@tektum/grimoire-core/ports/markdown-converter';
import { resolveLimits } from './limits.js';
import type { ConverterLimits } from './limits.js';
import type { WorkerRequest } from './worker.js';

/** Constructor options of the pooled converter; the defaults are listed in docs/proof/m2-pool.md. */
export interface ConverterOptions extends Partial<ConverterLimits> {
  /** Worker threads; 2 so that one document that runs to the time limit does not stop every other one. */
  poolSize?: number;
  /** Per `toMarkdown` call, queue wait plus run: the total a caller can wait. */
  timeoutMs?: number;
  /** Per `seed` call, queue wait plus run (the total a caller can wait): the bound on hostile Markdown, which the pre-check cannot make predictable. */
  seedTimeoutMs?: number;
  /** Per `reseed` call (the system rebuilding a page from Markdown its own serialiser stored): longer than a seed, because the Markdown may be four times larger and is not capped by lines. */
  reseedTimeoutMs?: number;
  /**
   * The most a call waits for a free worker before it answers `queue-timeout`. Default: a quarter of the call's total limit. The run then gets
   * the rest of the total (never less than three quarters of it by default), so queue wait plus run never exceeds the total.
   */
  queueWaitMs?: number;
  /** `resourceLimits.maxOldGenerationSizeMb` of each worker. */
  heapMb?: number;
  /** Calls that may wait for a free worker; one more is refused at once. Not in the contracts (see docs/proof/m2-pool.md). */
  queueLimit?: number;
  /** How long `close()` lets running and queued conversions finish before it terminates the workers. */
  closeDeadlineMs?: number;
  /** Worker entry file; tests substitute a fixture. Default: the built `worker.js`. */
  workerPath?: string;
  /**
   * TEST FACILITY ONLY (see the `test-facilities` settings in `packages/adapters/config-env/src/test-facilities.ts`): a conversion whose Markdown contains `marker` blocks its worker for
   * `ms` before it answers, so a test can make ONE page exceed the timeout. Reaches the worker once, as its start-up data; unset, nothing
   * is sent and the worker checks nothing. The server only passes it in local mode (packages/adapters/config-env/src/test-facilities.ts).
   */
  testSlow?: { readonly marker: string; readonly ms: number };
}

export interface ResolvedConverterOptions extends ConverterLimits {
  poolSize: number;
  timeoutMs: number;
  seedTimeoutMs: number;
  reseedTimeoutMs: number;
  queueWaitMs: number | undefined;
  heapMb: number;
  queueLimit: number;
  closeDeadlineMs: number;
  workerPath: string;
}

export interface PooledMarkdownConverter extends MarkdownConverter {
  readonly options: Readonly<ResolvedConverterOptions>;
  stats(): { threads: number; queued: number };
}

/**
 * The worker is the built file: the sources import each other with `.js` specifiers that Node cannot map back to `.ts`,
 * so a worker cannot start from `src`. Next to this file when it is the built one, `../dist` when it is the source
 * (the test runner), so a test run needs `bun run build` (or `tsc -b`) first.
 */
export function defaultWorkerPath(moduleUrl: string = import.meta.url): string {
  const built = moduleUrl.endsWith('.ts') ? '../dist/worker.js' : './worker.js';
  return fileURLToPath(new URL(built, moduleUrl));
}

const positive = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
};

/** `AbortSignal.timeout` accepts at most 2^32 - 1 ms; a longer timeout is refused at construction. */
const bounded = (name: string, value: number): number => {
  if (positive(name, value) > 4_294_967_295) throw new RangeError(`${name} must be at most 4294967295`);
  return value;
};

export function resolveOptions(options: ConverterOptions = {}): ResolvedConverterOptions {
  return {
    ...resolveLimits(options),
    poolSize: positive('poolSize', options.poolSize ?? 2),
    timeoutMs: bounded('timeoutMs', options.timeoutMs ?? 10_000),
    seedTimeoutMs: bounded('seedTimeoutMs', options.seedTimeoutMs ?? 10_000),
    reseedTimeoutMs: bounded('reseedTimeoutMs', options.reseedTimeoutMs ?? 30_000),
    queueWaitMs: options.queueWaitMs === undefined ? undefined : bounded('queueWaitMs', options.queueWaitMs),
    heapMb: positive('heapMb', options.heapMb ?? 512),
    queueLimit: positive('queueLimit', options.queueLimit ?? 32),
    closeDeadlineMs: positive('closeDeadlineMs', options.closeDeadlineMs ?? 5_000),
    workerPath: options.workerPath ?? defaultWorkerPath(),
  };
}

type Failure = { ok: false; reason: ConvertFailure & SeedFailure; detail: string; message?: string };
const fail = (reason: Failure['reason'], detail: string, message?: string): Failure => ({ ok: false, reason, detail, ...(message !== undefined ? { message } : {}) });
/** The person-readable sentence of each refusal the pool makes itself, by its stable code (`detail`). */
export const REFUSAL_MESSAGES = {
  'no-key': 'This request could not be started because it was not identified. Try again; if it keeps happening, report it.',
  'one-at-a-time': 'Another conversion for this page is still running. Try again in a moment.',
  'queue-full': 'The converter is busy with other pages. Try again in a moment.',
  closed: 'The converter is shutting down. Try again in a moment.',
} as const;
const refuse = (code: keyof typeof REFUSAL_MESSAGES): Failure => fail('internal', code, REFUSAL_MESSAGES[code]);
/** "10 seconds", "0.6 seconds". */
const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} seconds`;
const closedFailure = refuse('closed');

const CONVERT_REASONS: readonly string[] = ['invalid-state', 'too-large', 'too-deep', 'content-lost', 'timeout', 'queue-timeout', 'out-of-memory', 'internal'];
const SEED_REASONS: readonly string[] = ['invalid-markdown', 'too-large', 'timeout', 'queue-timeout', 'out-of-memory', 'internal'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A reply is checked, not trusted: a worker that answers with anything else is a failure of the pool, not a result. */
function asConvertResult(value: unknown): ConvertResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value['ok'] === true && typeof value['markdown'] === 'string' && typeof value['text'] === 'string') {
    return { ok: true, markdown: value['markdown'], text: value['text'] };
  }
  const { reason, detail } = value;
  if (value['ok'] === false && typeof reason === 'string' && typeof detail === 'string' && CONVERT_REASONS.includes(reason)) {
    return { ok: false, reason: reason as ConvertFailure, detail };
  }
  return undefined;
}

function asSeedResult(value: unknown): SeedResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value['ok'] === true && value['state'] instanceof Uint8Array) return { ok: true, state: value['state'] };
  const { reason, detail } = value;
  if (value['ok'] === false && typeof reason === 'string' && typeof detail === 'string' && SEED_REASONS.includes(reason)) {
    return { ok: false, reason: reason as SeedFailure, detail };
  }
  return undefined;
}

/** Piscina's own message for a full queue: it has no error class or code for it. */
const QUEUE_FULL = /queue is at limit|No task queue available/;

/** Pool errors to typed failures. The detail is fixed text: an error message could carry page content. */
function mapPoolError(error: unknown, signal: AbortSignal, closing: boolean, timedOut: { detail: string; message: string }): Failure {
  if (closing) return closedFailure;
  if (signal.aborted) return fail('timeout', timedOut.detail, timedOut.message);
  const code = isRecord(error) ? error['code'] : undefined;
  const message = isRecord(error) ? error['message'] : undefined;
  if (code === 'ERR_WORKER_OUT_OF_MEMORY') return fail('out-of-memory', 'the conversion exceeded the worker memory limit');
  if (typeof message === 'string' && QUEUE_FULL.test(message)) return refuse('queue-full');
  if (typeof message === 'string' && /^worker exited/.test(message)) return fail('internal', 'worker-exited');
  return fail('internal', 'worker-failed');
}

/**
 * The `MarkdownConverter` port on a piscina pool: in-process conversion in a worker thread so
 * the event loop stays free, one timeout over queue wait and run with real cancellation (piscina terminates and
 * replaces the worker), a heap limit, and the state bytes moved to the worker. Every method resolves, none rejects.
 */
export function createMarkdownConverter(options?: ConverterOptions): PooledMarkdownConverter {
  const resolved = resolveOptions(options);
  const { poolSize, timeoutMs, seedTimeoutMs, reseedTimeoutMs, queueWaitMs, heapMb, queueLimit, closeDeadlineMs, workerPath, ...limits } = resolved;
  const testSlow = options?.testSlow;
  if (testSlow && (testSlow.marker === '' || !Number.isInteger(testSlow.ms) || testSlow.ms < 1)) throw new RangeError('testSlow needs a marker and a positive integer ms');
  const pool = new Piscina<WorkerRequest, unknown>({
    filename: workerPath,
    minThreads: poolSize,
    maxThreads: poolSize,
    maxQueue: queueLimit,
    resourceLimits: { maxOldGenerationSizeMb: heapMb },
    closeTimeout: closeDeadlineMs,
    // The worker needs nothing from the server's environment (secrets live there) and nothing of its flags.
    env: {},
    execArgv: [],
    ...(testSlow ? { workerData: { testSlow: { marker: testSlow.marker, ms: testSlow.ms } } } : {}),
  });
  // An idle worker that dies, or a close that times out, has no caller to tell: piscina emits 'error', which throws without a listener.
  pool.on('error', () => undefined);

  let closing: Promise<void> | undefined;
  // Calls running or waiting. piscina's own `maxQueue` does not count a task that carries an AbortSignal, and every call does.
  let pending = 0;
  // Keys with a seed running or waiting.
  const seedKeys = new Set<string>();

  /** One conversion of Markdown to state: `seed` (user-supplied Markdown) or `reseed` (our own stored Markdown), one in flight per key and kind. */
  async function seedAs(op: 'seed' | 'reseed', scope: string, markdown: string, key: string, limitMs: number): Promise<SeedResult> {
    if (typeof key !== 'string' || key === '') return refuse('no-key');
    // One conversion in flight per key, refused at once rather than queued: a hostile document then costs only its sender.
    if (seedKeys.has(scope + key)) return refuse('one-at-a-time');
    seedKeys.add(scope + key);
    try {
      return await dispatch({ op, markdown, limits }, [], asSeedResult, limitMs, { detail: `the Markdown took too long to convert (limit ${limitMs} ms)`, message: `The text took longer than ${seconds(limitMs)} to convert, so it was not changed. Splitting the page into smaller pages may help.` });
    } finally {
      seedKeys.delete(scope + key);
    }
  }

  async function dispatch<R extends { ok: boolean }>(
    request: WorkerRequest,
    transferList: ArrayBuffer[],
    accept: (value: unknown) => R | undefined,
    limitMs: number,
    timedOut: { detail: string; message: string },
  ): Promise<R | Failure> {
    if (closing !== undefined) return closedFailure;
    if (pending >= poolSize + queueLimit) return refuse('queue-full');
    pending += 1;
    // Two clocks. The wait for a worker ends at `queueLimit`; the run starts with a worker and ends at the total, so wait plus run never exceeds `limitMs`.
    const admitted = performance.now();
    const waitLimitMs = Math.max(1, Math.min(queueWaitMs ?? Math.floor(limitMs / 4), limitMs - 1));
    const waitSignal = AbortSignal.timeout(waitLimitMs);
    let signal: AbortSignal | undefined;
    let slot = false;
    try {
      slot = await acquire(waitSignal);
      if (!slot) {
        if (closing !== undefined) return closedFailure;
        return fail('queue-timeout', `no worker was free within ${waitLimitMs} ms`, 'The converter is busy with other pages. Try again in a moment.');
      }
      signal = AbortSignal.timeout(Math.max(1, limitMs - Math.round(performance.now() - admitted)));
      // piscina's TransferList type resolves to the structured-clone options object when only Node's types are loaded; at run time it is an array.
      const reply = await pool.run(request, { signal, transferList: transferList as never });
      return accept(reply) ?? fail('internal', 'worker-bad-reply');
    } catch (error: unknown) {
      return mapPoolError(error, signal ?? AbortSignal.abort(), closing !== undefined, timedOut);
    } finally {
      if (slot) release();
      pending -= 1;
      if (pending === 0) for (const done of drained.splice(0)) done();
    }
  }

  // At most `poolSize` jobs are inside piscina at once, so piscina never queues one: the wait for a worker is ours, and so is its clock.
  let running = 0;
  const waiters: { grant: () => void; leave: () => void }[] = [];
  const drained: (() => void)[] = [];
  function acquire(signal: AbortSignal): Promise<boolean> {
    if (running < poolSize) { running += 1; return Promise.resolve(true); }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        grant: () => { signal.removeEventListener('abort', waiter.leave); resolve(true); },
        leave: () => { waiters.splice(waiters.indexOf(waiter), 1); resolve(false); },
      };
      signal.addEventListener('abort', waiter.leave, { once: true });
      waiters.push(waiter);
    });
  }
  function release(): void {
    const next = waiters.shift();
    if (next) next.grant(); // the slot passes on: `running` stays
    else running -= 1;
  }

  return {
    options: Object.freeze(resolved),
    async toMarkdown(state) {
      if (!(state instanceof Uint8Array)) return { ok: false, reason: 'invalid-state', detail: 'input is not a byte array' };
      // The copy is what moves: the caller keeps its own bytes (it writes them to the database), and a view into a
      // larger buffer must not detach the memory around it. A Buffer's slice() shares memory, so copy through the constructor.
      // Admission first (closed, queue, size): a hostile payload is never copied on this thread past the limit, and a detached buffer is a typed failure.
      if (closing !== undefined) return closedFailure;
      if (pending >= poolSize + queueLimit) return refuse('queue-full');
      if (state.byteLength > limits.maxStateBytes) return fail('too-large', `state of ${state.byteLength} bytes exceeds the limit`);
      let copy: Uint8Array;
      try {
        copy = new Uint8Array(state);
      } catch {
        return { ok: false, reason: 'invalid-state', detail: 'the byte array cannot be read' };
      }
      return dispatch({ op: 'to-markdown', state: copy, limits }, [copy.buffer as ArrayBuffer], asConvertResult, timeoutMs, { detail: 'the conversion exceeded its time limit', message: `This page took longer than ${seconds(timeoutMs)} to convert to Markdown. Your edit is kept; the Markdown copy was not updated.` });
    },
    seed: (markdown, key) => seedAs('seed', 'user:', markdown, key, seedTimeoutMs),
    reseed: (markdown, key) => seedAs('reseed', 'system:', markdown, key, reseedTimeoutMs),
    close() {
      // piscina's close waits for running and queued work up to closeTimeout, then terminates the workers.
      // Calls waiting for a worker are ours, not piscina's: let them finish (up to the deadline) before piscina closes.
      closing ??= (async () => {
        if (pending > 0) await Promise.race([new Promise<void>((r) => drained.push(r)), new Promise<void>((r) => setTimeout(r, closeDeadlineMs).unref())]);
        await pool.close().catch(() => undefined);
      })();
      return closing;
    },
    stats: () => ({ threads: pool.threads.length, queued: Math.max(0, pending - poolSize) }),
  };
}
