import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMarkdownConverter } from '../../src/index.js';
import type { ConverterOptions, PooledMarkdownConverter } from '../../src/index.js';
import { ensureBuilt, FIXTURE_WORKER } from './support.js';

const open: PooledMarkdownConverter[] = [];
const fixture = (options: ConverterOptions = {}): PooledMarkdownConverter => {
  const converter = createMarkdownConverter({ workerPath: FIXTURE_WORKER, ...options });
  open.push(converter);
  return converter;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((converter) => converter.close()));
});
beforeAll(ensureBuilt);

const OK = { ok: true };

describe('timeout', () => {
  it('stops a spinning worker, answers within the limit plus a bound, and the next call succeeds on a replaced worker', async () => {
    const converter = fixture({ timeoutMs: 500 });
    const started = performance.now();
    const result = await converter.seed('spin');
    const took = performance.now() - started;
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(took).toBeGreaterThanOrEqual(450);
    expect(took).toBeLessThan(1500);
    // The spin lasts 5 s: an answer in about 1 s means the thread was terminated, not waited for.
    const next = performance.now();
    expect(await converter.seed('echo')).toMatchObject(OK);
    expect(performance.now() - next).toBeLessThan(2000);
    expect(converter.stats().threads).toBe(1);
  });
  it('covers the wait in the queue as well as the run', async () => {
    const converter = fixture({ timeoutMs: 500 });
    const [first, second] = await Promise.all([converter.seed('busy-300'), converter.seed('busy-300')]);
    expect(first).toMatchObject(OK);
    expect(second).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('memory', () => {
  it('a conversion past the heap limit is out-of-memory, the worker is replaced and the process stays up', async () => {
    const converter = fixture({ heapMb: 64 });
    expect(await converter.seed('alloc')).toMatchObject({ ok: false, reason: 'out-of-memory' });
    expect(await converter.seed('echo')).toMatchObject(OK);
  });
  it('twenty failing conversions in a row leave the pool serving (the 200-run is in measure.mjs)', async () => {
    const converter = fixture({ heapMb: 32 });
    for (let i = 0; i < 20; i += 1) expect(await converter.seed('alloc')).toMatchObject({ ok: false, reason: 'out-of-memory' });
    expect(await converter.seed('echo')).toMatchObject(OK);
  }, 60_000);
});

describe('crash containment', () => {
  it('a worker that throws, exits, throws asynchronously or answers nonsense fails that caller only, with no process-level error', async () => {
    const unhandled: unknown[] = [];
    const record = (error: unknown): void => void unhandled.push(error);
    process.on('unhandledRejection', record);
    process.on('uncaughtException', record);
    try {
      const converter = fixture();
      expect(await converter.seed('throw')).toEqual({ ok: false, reason: 'internal', detail: 'worker-failed' });
      expect(await converter.seed('exit')).toEqual({ ok: false, reason: 'internal', detail: 'worker-exited' });
      expect(await converter.seed('async-throw')).toMatchObject({ ok: false, reason: 'internal' });
      expect(await converter.seed('bad-reply')).toEqual({ ok: false, reason: 'internal', detail: 'worker-bad-reply' });
      expect(await converter.seed('echo')).toMatchObject(OK);
      // Only the caller of the failing call hears of it: a call queued behind a crash still succeeds.
      const [crashed, bystander] = await Promise.all([converter.seed('exit'), converter.seed('echo')]);
      expect(crashed.ok).toBe(false);
      expect(bystander).toMatchObject(OK);
      // Every worker event has been delivered once close() resolves (it waits for the workers to exit); one more turn flushes the callbacks.
      await converter.close();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', record);
      process.off('uncaughtException', record);
    }
    expect(unhandled).toEqual([]);
  });
  it('never puts text of an error into a failure', async () => {
    const converter = fixture();
    for (const command of ['throw', 'async-throw']) {
      expect(JSON.stringify(await converter.seed(command))).not.toContain('SECRET');
    }
  });
  it('a worker file that cannot load fails calls by timeout, not by hanging or throwing', async () => {
    const converter = fixture({ workerPath: `${FIXTURE_WORKER}.missing`, timeoutMs: 300 });
    expect(await converter.seed('echo')).toMatchObject({ ok: false });
  });
});

describe('back-pressure', () => {
  it('refuses the call past the queue limit at once, typed, while earlier calls keep their place', async () => {
    const converter = fixture({ queueLimit: 2, timeoutMs: 5000 });
    const running = converter.seed('busy-300');
    const queued = [converter.seed('echo'), converter.seed('echo')];
    // The calls are admitted synchronously, so the queue already holds the two: observed, not waited for.
    expect(converter.stats().queued).toBe(2);
    // "At once" is shown by order, not by a clock: the refusal arrives while the running call (a 300 ms busy loop) has not finished.
    const refused = await Promise.race([converter.seed('echo'), running.then(() => 'the running call finished first' as const)]);
    expect(refused).toEqual({ ok: false, reason: 'internal', detail: 'queue-full' });
    expect(converter.stats().queued).toBe(2);
    expect(await running).toMatchObject(OK);
    expect(await Promise.all(queued)).toEqual([expect.objectContaining(OK), expect.objectContaining(OK)]);
  });
  it('a pool of two runs two calls at once', async () => {
    const converter = fixture({ poolSize: 2, timeoutMs: 5000 });
    const started = performance.now();
    const results = await Promise.all([converter.seed('stamp'), converter.seed('stamp')]);
    const spans = results.map((r) => {
      if (!r.ok) throw new Error(`a call failed: ${r.reason}`);
      const [start = 0, end = 0] = new Float64Array(r.state.buffer.slice(r.state.byteOffset, r.state.byteOffset + 16));
      return { start, end };
    });
    // Each call reports when it ran: one after the other would put the second start at or after the first end.
    const [a, b] = spans as [{ start: number; end: number }, { start: number; end: number }];
    expect(Math.max(a.start, b.start)).toBeLessThan(Math.min(a.end, b.end));
    expect(performance.now() - started).toBeLessThan(5000); // a sanity bound only
  });
});

describe('shutdown', () => {
  it('close() lets a running conversion finish within the deadline', async () => {
    const converter = fixture({ closeDeadlineMs: 2000 });
    const running = converter.seed('busy-300');
    // No wait for the worker to start: close() lets running AND queued work finish, so the call is answered either way.
    await converter.close();
    expect(await running).toMatchObject(OK);
    expect(converter.stats().threads).toBe(0);
  });
  it('past the deadline close() terminates the worker: the caller gets a typed failure and no thread is left', async () => {
    const converter = fixture({ closeDeadlineMs: 200, timeoutMs: 20_000 });
    const running = converter.seed('spin');
    // No wait for the worker to start: whether the call has started or still waits, the deadline ends it the same way.
    const started = performance.now();
    await converter.close();
    expect(performance.now() - started).toBeLessThan(1500);
    expect(await running).toEqual({ ok: false, reason: 'internal', detail: 'closed' });
    expect(converter.stats().threads).toBe(0);
    expect(await converter.seed('echo')).toEqual({ ok: false, reason: 'internal', detail: 'closed' });
  });
});
