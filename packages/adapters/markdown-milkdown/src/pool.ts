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
  /** Worker threads; 1 because the pool is a guard, not a speed-up. */
  poolSize?: number;
  /** Per call, queue wait plus run. */
  timeoutMs?: number;
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
    poolSize: positive('poolSize', options.poolSize ?? 1),
    timeoutMs: bounded('timeoutMs', options.timeoutMs ?? 10_000),
    heapMb: positive('heapMb', options.heapMb ?? 512),
    queueLimit: positive('queueLimit', options.queueLimit ?? 32),
    closeDeadlineMs: positive('closeDeadlineMs', options.closeDeadlineMs ?? 5_000),
    workerPath: options.workerPath ?? defaultWorkerPath(),
  };
}

type Failure = { ok: false; reason: ConvertFailure & SeedFailure; detail: string };
const fail = (reason: Failure['reason'], detail: string): Failure => ({ ok: false, reason, detail });
const closedFailure = fail('internal', 'closed');

const CONVERT_REASONS: readonly string[] = ['invalid-state', 'too-large', 'too-deep', 'content-lost', 'timeout', 'out-of-memory', 'internal'];
const SEED_REASONS: readonly string[] = ['invalid-markdown', 'too-large', 'timeout', 'out-of-memory', 'internal'];

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
function mapPoolError(error: unknown, signal: AbortSignal, closing: boolean): Failure {
  if (closing) return closedFailure;
  if (signal.aborted) return fail('timeout', 'the conversion exceeded its time limit');
  const code = isRecord(error) ? error['code'] : undefined;
  const message = isRecord(error) ? error['message'] : undefined;
  if (code === 'ERR_WORKER_OUT_OF_MEMORY') return fail('out-of-memory', 'the conversion exceeded the worker memory limit');
  if (typeof message === 'string' && QUEUE_FULL.test(message)) return fail('internal', 'queue-full');
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
  const { poolSize, timeoutMs, heapMb, queueLimit, closeDeadlineMs, workerPath, ...limits } = resolved;
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

  async function dispatch<R extends { ok: boolean }>(
    request: WorkerRequest,
    transferList: ArrayBuffer[],
    accept: (value: unknown) => R | undefined,
  ): Promise<R | Failure> {
    if (closing !== undefined) return closedFailure;
    if (pending >= poolSize + queueLimit) return fail('internal', 'queue-full');
    pending += 1;
    // Created now, so the limit covers the wait in the queue as well as the run.
    let signal: AbortSignal | undefined;
    try {
      signal = AbortSignal.timeout(timeoutMs);
      // piscina's TransferList type resolves to the structured-clone options object when only Node's types are loaded; at run time it is an array.
      const reply = await pool.run(request, { signal, transferList: transferList as never });
      return accept(reply) ?? fail('internal', 'worker-bad-reply');
    } catch (error: unknown) {
      return mapPoolError(error, signal ?? AbortSignal.abort(), closing !== undefined);
    } finally {
      pending -= 1;
    }
  }

  return {
    options: Object.freeze(resolved),
    async toMarkdown(state) {
      if (!(state instanceof Uint8Array)) return { ok: false, reason: 'invalid-state', detail: 'input is not a byte array' };
      // The copy is what moves: the caller keeps its own bytes (it writes them to the database), and a view into a
      // larger buffer must not detach the memory around it. A Buffer's slice() shares memory, so copy through the constructor.
      // Admission first (closed, queue, size): a hostile payload is never copied on this thread past the limit, and a detached buffer is a typed failure.
      if (closing !== undefined) return closedFailure;
      if (pending >= poolSize + queueLimit) return fail('internal', 'queue-full');
      if (state.byteLength > limits.maxStateBytes) return fail('too-large', `state of ${state.byteLength} bytes exceeds the limit`);
      let copy: Uint8Array;
      try {
        copy = new Uint8Array(state);
      } catch {
        return { ok: false, reason: 'invalid-state', detail: 'the byte array cannot be read' };
      }
      return dispatch({ op: 'to-markdown', state: copy, limits }, [copy.buffer as ArrayBuffer], asConvertResult);
    },
    seed(markdown) {
      return dispatch({ op: 'seed', markdown, limits }, [], asSeedResult);
    },
    close() {
      // piscina's close waits for running and queued work up to closeTimeout, then terminates the workers.
      closing ??= pool.close().catch(() => undefined);
      return closing;
    },
    stats: () => ({ threads: pool.threads.length, queued: Math.max(0, pending - poolSize) }),
  };
}
