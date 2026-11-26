import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SemanticConfig } from '@tektum/grimoire-core/ports/config';
import type { EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from '../src/backend.js';
import { createOnnxEmbedder, type OnnxEmbedderOptions } from '../src/embedder.js';
import type { TextKind } from '../src/prefix.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const weights = Buffer.from('the weights');
const tokenizer = Buffer.from('{"the":"tokenizer"}');
const lockText = JSON.stringify({
  files: [
    { model: 'multilingual-e5-base', name: 'model_quantized.onnx', sha256: sha(weights), size: weights.length },
    { model: 'multilingual-e5-base', name: 'tokenizer.json', sha256: sha(tokenizer), size: tokenizer.length },
  ],
});

const config = (modelDir: string, over: Partial<SemanticConfig> = {}): SemanticConfig => ({
  enabled: true,
  model: 'multilingual-e5-base',
  modelDir,
  threads: 2,
  debounceSeconds: 30,
  sweepSeconds: 15,
  maxChunksPerMinute: 600,
  queryTimeoutMs: 1500,
  minSimilarity: 0,
  candidates: 100,
  ...over,
});

/** A model with no model: each batch waits for the test to release it (or is answered at once), and the batches are recorded. */
class FakeBackend implements Backend {
  readonly batches: { kind: TextKind; texts: readonly string[] }[] = [];
  started = false;
  closed = false;
  hold = false;
  startError: Error | undefined;
  private releases: (() => void)[] = [];
  private stopped: (() => void) | undefined;
  start(): Promise<void> {
    if (this.startError !== undefined) return Promise.reject(this.startError);
    this.started = true;
    return Promise.resolve();
  }
  embed(kind: TextKind, texts: readonly string[]): Promise<EmbedResult> {
    this.batches.push({ kind, texts });
    const answer = (): EmbedResult => ({ ok: true, vectors: texts.map((t) => Float32Array.from([t.length, 1])) });
    if (!this.hold) return Promise.resolve(answer());
    return new Promise((resolve) => this.releases.push(() => resolve(answer())));
  }
  release(): void {
    for (const r of this.releases.splice(0)) r();
  }
  count(text: string): Promise<number | undefined> {
    return Promise.resolve(text.split(' ').filter(Boolean).length);
  }
  onStopped(listener: () => void): void {
    this.stopped = listener;
  }
  stop(): void {
    this.stopped?.();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(options: { files?: boolean; lock?: boolean } = {}) {
  const dir = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'grimoire-embedder-'));
  dirs.push(dir);
  const put = (): void => {
    mkdirSync(path.join(dir, 'multilingual-e5-base'), { recursive: true });
    writeFileSync(path.join(dir, 'multilingual-e5-base', 'model_quantized.onnx'), weights);
    writeFileSync(path.join(dir, 'multilingual-e5-base', 'tokenizer.json'), tokenizer);
  };
  if (options.files !== false) put();
  if (options.lock !== false) writeFileSync(path.join(dir, 'models.lock.json'), lockText);
  const backends: FakeBackend[] = [];
  const logs: { event: string; fields: unknown }[] = [];
  const log = {
    error: (event: string, fields: unknown) => logs.push({ event, fields }),
    debug() {},
    info() {},
    warn() {},
    child() {
      return log;
    },
  };
  const make = (over: Partial<OnnxEmbedderOptions> = {}, cfg: Partial<SemanticConfig> = {}) =>
    createOnnxEmbedder(config(dir, cfg), {
      log,
      retryMs: 20,
      makeBackend: () => {
        const b = new FakeBackend();
        backends.push(b);
        return b;
      },
      ...over,
    });
  return { dir, put, backends, logs, make };
}
const ready = (e: ReturnType<ReturnType<typeof setup>['make']>) => vi.waitFor(() => expect(e.status()).toBe('ready'));

/** The retry timers of a test's embedder, seen from outside: how many were set with this delay (each test that counts gives its embedder a delay of its own, so that an embedder another test left running is not counted), and how many timers were cleared. */
function watchTimers(delay: number) {
  const set = vi.spyOn(globalThis, 'setTimeout');
  const cleared = vi.spyOn(globalThis, 'clearTimeout');
  return { retries: () => set.mock.calls.filter((call) => call[1] === delay).length, cleared: () => cleared.mock.calls.length };
}
/** One turn of the event loop: every continuation that was waiting on a promise has run. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('loading', () => {
  it('is loading, then ready; the version is the start of the weights hash, and tokens are counted on the model thread once it is loaded', async () => {
    const s = setup();
    const e = s.make();
    expect(e.status()).toBe('loading');
    expect(await e.countTokens('one two three')).toBe(5); // an estimate until the model thread is there
    expect(await e.embedPassages(['a'])).toEqual({ ok: false, reason: 'unavailable' });
    await ready(e);
    // 512 is the model's limit; the text a chunker may hand over leaves room for the two special tokens and the prefix.
    expect(e.model).toEqual({ name: 'multilingual-e5-base', version: `int8@${sha(weights).slice(0, 8)}`, dims: 768, maxTokens: 504 });
    expect(await e.countTokens('one two three')).toBe(3);
    expect(s.logs).toEqual([]);
    await e.close();
  });

  it('describes the small model with its own vector length', async () => {
    const s = setup();
    expect(s.make({}, { model: 'multilingual-e5-small' }).model).toMatchObject({ name: 'multilingual-e5-small', dims: 384, maxTokens: 504 });
  });

  it('is unavailable with model-missing for no lock or no file, says so once, and loads when the files come (the retry)', async () => {
    const s = setup({ files: false });
    const timers = watchTimers(21);
    const e = s.make({ retryMs: 21 });
    await vi.waitFor(() => expect(s.logs).toHaveLength(1));
    expect(e.status()).toBe('unavailable');
    expect(s.logs[0]).toEqual({ event: 'semantic.unavailable', fields: { reason: 'model-missing' } });
    await vi.waitFor(() => expect(timers.retries()).toBeGreaterThanOrEqual(3)); // the load was tried three times and failed three times: none said it again
    expect(s.logs).toHaveLength(1);
    s.put();
    await ready(e);
    expect(await e.embedQuery('x')).toMatchObject({ ok: true });
    await e.close();
    const noLock = setup({ lock: false });
    const e2 = noLock.make();
    await vi.waitFor(() => expect(e2.status()).toBe('unavailable'));
    expect(noLock.logs[0]?.fields).toEqual({ reason: 'model-missing' });
    expect(e2.model.version).toBe('int8@unknown');
    await e2.close();
  });

  it('is unavailable with model-hash-mismatch for a file with one byte changed, and recovers when it is put right', async () => {
    const s = setup();
    const file = path.join(s.dir, 'multilingual-e5-base', 'model_quantized.onnx');
    const flipped = Buffer.from(weights);
    flipped[0] = (flipped[0] as number) ^ 1;
    writeFileSync(file, flipped);
    const e = s.make();
    await vi.waitFor(() => expect(s.logs).toHaveLength(1));
    expect(s.logs[0]?.fields).toEqual({ reason: 'model-hash-mismatch' });
    expect(s.backends).toHaveLength(0); // nothing was started on a file that is not the locked one
    writeFileSync(file, weights);
    await ready(e);
    await e.close();
  });

  it('is unavailable with load-failed when the model cannot be started, closes what it made, and tries again', async () => {
    const s = setup();
    let attempts = 0;
    const e = s.make({
      makeBackend: () => {
        const b = new FakeBackend();
        if ((attempts += 1) === 1) b.startError = new Error('no');
        s.backends.push(b);
        return b;
      },
    });
    await vi.waitFor(() => expect(s.logs).toHaveLength(1));
    expect(s.logs[0]?.fields).toEqual({ reason: 'load-failed' });
    expect(s.backends[0]?.closed).toBe(true);
    await ready(e);
    await e.close();
  });

  it('is unavailable with runtime-failed when the model stops, logs it again after having been ready, and loads again', async () => {
    const s = setup();
    const e = s.make();
    await ready(e);
    s.backends[0]?.stop();
    expect(e.status()).toBe('unavailable');
    expect(s.logs).toEqual([{ event: 'semantic.unavailable', fields: { reason: 'runtime-failed' } }]);
    expect(s.backends[0]?.closed).toBe(true);
    await ready(e);
    expect(s.backends).toHaveLength(2);
    s.backends[0]?.stop(); // the old one, long gone: no effect
    expect(e.status()).toBe('ready');
    await e.close();
  });

  it('does not start a model, or retry, once it is closed', async () => {
    const s = setup({ files: false });
    const timers = watchTimers(22);
    const e = s.make({ retryMs: 22 });
    await vi.waitFor(() => expect(s.logs).toHaveLength(1));
    const clearedBefore = timers.cleared();
    await e.close();
    expect(timers.cleared()).toBeGreaterThan(clearedBefore); // the pending retry is cancelled, so nothing can load the files that come now
    s.put();
    await turn();
    expect(s.backends).toHaveLength(0);
    expect(e.status()).toBe('unavailable');
    const early = setup().make();
    await early.close(); // closed while the files are still being checked
    // There is no event for a start that does not happen. The check reads two files of a few bytes: 100 ms is many times what it takes, and a start that was not prevented would show as a model.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(early.status()).toBe('unavailable');
  });

  it('closes a model that was started just as the embedder was closed', async () => {
    const s = setup();
    let release: () => void = () => undefined;
    let entered = false;
    const slow = new FakeBackend();
    slow.start = () =>
      new Promise<void>((resolve) => {
        entered = true;
        release = resolve;
      });
    const e = s.make({ makeBackend: () => slow });
    await vi.waitFor(() => expect(entered).toBe(true));
    await e.close();
    release();
    await vi.waitFor(() => expect(slow.closed).toBe(true));
    expect(e.status()).toBe('unavailable');
  });
});

describe('closing while the model starts', () => {
  it('reports nothing and starts no retry when the start that was running fails after the close', async () => {
    const s = setup();
    let fail: (e: Error) => void = () => undefined;
    let entered = false;
    const slow = new FakeBackend();
    slow.start = () =>
      new Promise<void>((_, reject) => {
        entered = true;
        fail = reject;
      });
    const e = s.make({ makeBackend: () => slow, retryMs: 24 });
    await vi.waitFor(() => expect(entered).toBe(true));
    const timers = watchTimers(24);
    const retriesBefore = timers.retries();
    await e.close();
    fail(new Error('refused'));
    await vi.waitFor(() => expect(slow.closed).toBe(true));
    await turn(); // the rest of the failed start (the report and the retry it would have made) runs on promises: after this turn it has run or it never will
    expect(timers.retries()).toBe(retriesBefore);
    expect(s.logs).toEqual([]);
    expect(s.backends).toHaveLength(0);
    expect(e.status()).toBe('unavailable');
  });
});

describe('embedding', () => {
  it('sends the texts of a call in batches of 8 and gives the vectors in the order of the texts', async () => {
    const s = setup();
    const e = s.make();
    await ready(e);
    const texts = Array.from({ length: 19 }, (_, i) => 'x'.repeat(i + 1));
    const r = await e.embedPassages(texts);
    expect(s.backends[0]?.batches.map((b) => b.texts.length)).toEqual([8, 8, 3]);
    expect(r.ok && r.vectors.map((v) => v[0])).toEqual(texts.map((t) => t.length));
    expect(await e.embedPassages([])).toEqual({ ok: true, vectors: [] });
    await e.close();
  });

  it('answers a failure of a batch as it is, and the rest of the call is not sent', async () => {
    const s = setup();
    const e = s.make();
    await ready(e);
    const b = s.backends[0] as FakeBackend;
    b.embed = (kind, texts) => {
      b.batches.push({ kind, texts });
      return Promise.resolve({ ok: false, reason: 'too-long' });
    };
    expect(await e.embedPassages(Array.from({ length: 20 }, () => 'a'))).toEqual({ ok: false, reason: 'too-long' });
    expect(b.batches).toHaveLength(1);
    await e.close();
  });

  it('serves a query before the passages that wait, one batch at a time', async () => {
    const s = setup();
    const e = s.make();
    await ready(e);
    const b = s.backends[0] as FakeBackend;
    b.hold = true;
    const first = e.embedPassages(['first']);
    const second = e.embedPassages(['second']);
    const query = e.embedQuery('query');
    await vi.waitFor(() => expect(b.batches).toHaveLength(1));
    expect(e.stats().queued).toBe(2);
    b.release();
    await vi.waitFor(() => expect(b.batches.map((x) => x.kind)).toEqual(['passage', 'query']));
    b.release();
    await vi.waitFor(() => expect(b.batches).toHaveLength(3));
    b.release();
    expect((await Promise.all([first, second, query])).every((r) => r.ok)).toBe(true);
    expect(b.batches.map((x) => x.texts[0])).toEqual(['first', 'query', 'second']);
    await e.close();
  });

  it('answers aborted at once for a signal that is aborted, queued or running, and a later call is served', async () => {
    const s = setup();
    const e = s.make();
    await ready(e);
    const b = s.backends[0] as FakeBackend;
    const already = new AbortController();
    already.abort();
    expect(await e.embedQuery('a', { signal: already.signal })).toEqual({ ok: false, reason: 'aborted' });
    expect(b.batches).toHaveLength(0);
    b.hold = true;
    const running = new AbortController();
    const queued = new AbortController();
    const one = e.embedPassages(['running'], { signal: running.signal });
    const two = e.embedPassages(['queued'], { signal: queued.signal });
    await vi.waitFor(() => expect(b.batches).toHaveLength(1));
    queued.abort();
    expect(await two).toEqual({ ok: false, reason: 'aborted' });
    expect(e.stats().queued).toBe(0);
    running.abort();
    expect(await one).toEqual({ ok: false, reason: 'aborted' });
    const later = e.embedPassages(['later']);
    b.release(); // the aborted batch ends; the later one starts
    await vi.waitFor(() => expect(b.batches).toHaveLength(2));
    b.release();
    expect(await later).toMatchObject({ ok: true });
    expect(b.batches.map((x) => x.texts[0])).toEqual(['running', 'later']);
    await e.close();
  });

  it('answers timeout for a query that is not served in time, from the setting unless the call says, and leaves the queue', async () => {
    const s = setup();
    const e = s.make({}, { queryTimeoutMs: 30 });
    await ready(e);
    const b = s.backends[0] as FakeBackend;
    b.hold = true;
    void e.embedPassages(['busy']);
    await vi.waitFor(() => expect(b.batches).toHaveLength(1));
    expect(await e.embedQuery('late')).toEqual({ ok: false, reason: 'timeout' });
    expect(await e.embedQuery('later', { timeoutMs: 5 })).toEqual({ ok: false, reason: 'timeout' });
    expect(e.stats().queued).toBe(0);
    b.release();
    await e.close();
  });

  it('answers unavailable to what waits when it is closed, and from then on; close is idempotent', async () => {
    const s = setup();
    const e = s.make();
    await ready(e);
    const b = s.backends[0] as FakeBackend;
    b.hold = true;
    void e.embedPassages(['busy']);
    await vi.waitFor(() => expect(b.batches).toHaveLength(1));
    const waiting = e.embedPassages(['waits']);
    await e.close();
    await e.close();
    expect(await waiting).toEqual({ ok: false, reason: 'unavailable' });
    expect(b.closed).toBe(true);
    expect(e.status()).toBe('unavailable');
    expect(await e.embedPassages(['a'])).toEqual({ ok: false, reason: 'unavailable' });
    expect(await e.embedQuery('a')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('answers unavailable to a batch that was waiting when the model stopped', async () => {
    const s = setup();
    const e = s.make();
    await ready(e);
    const b = s.backends[0] as FakeBackend;
    b.hold = true;
    const first = e.embedPassages(['busy']);
    const second = e.embedPassages(['waits']);
    await vi.waitFor(() => expect(b.batches).toHaveLength(1));
    b.stop();
    b.release();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toEqual({ ok: false, reason: 'unavailable' });
    await e.close();
  });
});

describe('stats', () => {
  it('shows the threads of the setting, the batches waiting, and the chunks embedded in the last minute', async () => {
    const s = setup();
    let clock = 1_000_000;
    const e = s.make({ now: () => clock }, { threads: 3 });
    await ready(e);
    expect(e.stats()).toEqual({ threads: 3, queued: 0, chunksPerMinute: 0 });
    await e.embedPassages(['a', 'b', 'c']);
    expect(e.stats().chunksPerMinute).toBe(3);
    clock += 30_000;
    await e.embedPassages(['d']);
    expect(e.stats().chunksPerMinute).toBe(4);
    clock += 45_000; // the first three are now more than a minute old
    expect(e.stats().chunksPerMinute).toBe(1);
    clock += 60_000;
    expect(e.stats().chunksPerMinute).toBe(0);
    await e.close();
  });
});

describe('the defaults', () => {
  const stub = pathToFileURL(path.resolve(import.meta.dirname, 'support/stub-worker.mjs'));

  it('starts the thread of the worker it is given when nothing else is, and embeds through it', async () => {
    const s = setup();
    const e = createOnnxEmbedder(config(s.dir), { workerUrl: stub });
    await ready(e);
    const r = await e.embedPassages(['a', 'b']);
    expect(r.ok && r.vectors.map((v) => v.length)).toEqual([768, 768]);
    await e.close();
  });

  it('looks for worker.js next to its own file when it is not told where, which is not there when it runs from the sources: load-failed, never a throw', async () => {
    const s = setup();
    const e = createOnnxEmbedder(config(s.dir), {
      retryMs: 1_000_000,
      log: {
        error: (event: string, fields: unknown) => s.logs.push({ event, fields }),
        debug() {},
        info() {},
        warn() {},
        child() {
          return this;
        },
      } as never,
    });
    await vi.waitFor(() => expect(s.logs).toEqual([{ event: 'semantic.unavailable', fields: { reason: 'load-failed' } }]));
    await e.close();
  });
});

describe('the real files', () => {
  it('reads the lock next to the models by default, and an unreadable directory is just unavailable', async () => {
    const s = setup();
    if (process.getuid?.() !== 0) chmodSync(s.dir, 0o000);
    const e = createOnnxEmbedder(config(s.dir), { retryMs: 1_000_000, makeBackend: () => new FakeBackend() });
    await vi.waitFor(() => expect(e.status()).toBe(process.getuid?.() === 0 ? 'ready' : 'unavailable'));
    chmodSync(s.dir, 0o755);
    await e.close();
  });
});
