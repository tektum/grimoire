import path from 'node:path';
import type { Logger } from '@tektum/grimoire-core/ports/logger';
import type { SemanticConfig } from '@tektum/grimoire-core/ports/config';
import type { EmbedResult, Embedder } from '@tektum/grimoire-core/ports/embedder';
import type { Backend } from './backend.js';
import { readLock, verifyFiles, versionOf } from './lock.js';
import type { TextKind } from './prefix.js';
import { createThreadBackend } from './thread-backend.js';
import { loadTokenCounter, type TokenCounter } from './tokenizer.js';

/** The models the setting names: the length of their vectors, and the most tokens a text may have (the model's limit, the special tokens and the prefix included). */
const MODELS = { 'multilingual-e5-base': { dims: 768 }, 'multilingual-e5-small': { dims: 384 } } as const;
const MAX_TOKENS = 512;
/** Texts of one call go to the model this many at a time: an aborted call leaves at most one batch running, and a query does not wait behind a whole page. */
const BATCH = 8;
const MINUTE_MS = 60_000;

export interface OnnxEmbedderOptions {
  readonly log?: Logger;
  /** How long after a failed load the next one starts (default 60 s). */
  readonly retryMs?: number;
  /** The lock the files are checked against (default `<modelDir>/models.lock.json`, the copy the image holds). */
  readonly lockFile?: string;
  /** The compiled `worker.js` of the default backend (default: the one next to this file, which is right when this file is compiled too). */
  readonly workerUrl?: URL;
  /** What runs the model (default: a worker thread). */
  readonly makeBackend?: (threads: number, dims: number) => Backend;
  readonly loadTokenCounter?: (file: string) => TokenCounter;
  readonly now?: () => number;
}

interface Task {
  readonly kind: TextKind;
  readonly texts: readonly string[];
  readonly settle: (result: EmbedResult) => void;
  settled: boolean;
}

const UNAVAILABLE: EmbedResult = { ok: false, reason: 'unavailable' };

/**
 * The embedder of the semantic search (contracts section 15): the e5 model on the CPU, in a thread of its own. It checks every model file against the lock before it loads
 * anything (`model-hash-mismatch`, `model-missing`), reports `unavailable` while it cannot (and says so once in the log, `semantic.unavailable`), tries again every minute, and
 * never throws. A query is served before the passages that wait; a call that is aborted or out of time gives its answer at once and leaves at most one batch of 8 texts running.
 */
export function createOnnxEmbedder(config: SemanticConfig, options: OnnxEmbedderOptions = {}): Embedder {
  const dims = MODELS[config.model].dims;
  const retryMs = options.retryMs ?? MINUTE_MS;
  const now = options.now ?? Date.now;
  const lockFile = options.lockFile ?? path.join(config.modelDir, 'models.lock.json');
  const makeBackend = options.makeBackend ?? ((threads, d) => createThreadBackend({ workerUrl: options.workerUrl ?? new URL('./worker.js', import.meta.url), threads, dims: d, maxTokens: MAX_TOKENS }));
  const makeCounter = options.loadTokenCounter ?? loadTokenCounter;

  let status: 'loading' | 'ready' | 'unavailable' = 'loading';
  let closed = false;
  let backend: Backend | undefined;
  let counter: TokenCounter | undefined;
  let retry: NodeJS.Timeout | undefined;
  let reported = false;
  let running = false;
  const queue: Task[] = [];
  const embedded: number[] = [];
  let version = versionOf(undefined);

  function fail(reason: 'model-missing' | 'model-hash-mismatch' | 'load-failed' | 'runtime-failed'): void {
    status = 'unavailable';
    if (!reported) options.log?.error('semantic.unavailable', { reason });
    reported = true;
    retry = setTimeout(() => void load(), retryMs);
    retry.unref();
  }

  async function load(): Promise<void> {
    const locked = await readLock(lockFile, config.model);
    version = versionOf(locked);
    const verified = await verifyFiles(config.modelDir, config.model, locked);
    if (closed) return;
    if (!verified.ok) return fail(verified.reason);
    const next = makeBackend(config.threads, dims);
    try {
      counter = makeCounter(verified.tokenizer);
      await next.start({ weights: verified.weights, tokenizer: verified.tokenizer });
    } catch {
      await next.close();
      return fail('load-failed');
    }
    if (closed) return void (await next.close());
    next.onStopped(() => {
      if (backend !== next) return;
      backend = undefined;
      void next.close();
      fail('runtime-failed');
    });
    backend = next;
    status = 'ready';
    reported = false;
    pump();
  }

  /** One batch at a time, queries first. */
  function pump(): void {
    if (running) return;
    const at = queue.findIndex((t) => t.kind === 'query');
    const task = queue.splice(at === -1 ? 0 : at, 1)[0];
    if (task === undefined) return;
    const current = backend;
    if (current === undefined || status !== 'ready') {
      finish(task, UNAVAILABLE);
      return pump();
    }
    running = true;
    void current.embed(task.kind, task.texts).then((result) => {
      running = false;
      if (result.ok) {
        const t = now();
        for (let i = 0; i < result.vectors.length; i += 1) embedded.push(t);
      }
      finish(task, result);
      pump();
    });
  }

  function finish(task: Task, result: EmbedResult): void {
    if (task.settled) return;
    task.settled = true;
    task.settle(result);
  }

  /** The batch is answered by the model, by the signal (`aborted`) or by the clock (`timeout`), whichever comes first. */
  function submit(kind: TextKind, texts: readonly string[], signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<EmbedResult> {
    if (closed || status !== 'ready') return Promise.resolve(UNAVAILABLE);
    if (signal?.aborted === true) return Promise.resolve({ ok: false, reason: 'aborted' });
    return new Promise<EmbedResult>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const task: Task = {
        kind,
        texts,
        settled: false,
        settle: (result) => {
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
          resolve(result);
        },
      };
      const leave = (reason: 'aborted' | 'timeout'): void => {
        const at = queue.indexOf(task);
        if (at !== -1) queue.splice(at, 1);
        finish(task, { ok: false, reason });
      };
      if (timeoutMs !== undefined) timer = setTimeout(() => leave('timeout'), timeoutMs);
      if (signal !== undefined) {
        onAbort = () => leave('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      }
      queue.push(task);
      pump();
    });
  }

  void load();

  return {
    get model() {
      return { name: config.model, version, dims, maxTokens: MAX_TOKENS };
    },
    status: () => (closed ? 'unavailable' : status),
    countTokens: (text) => (counter === undefined ? Math.ceil(text.length / 3) : counter.count(text)),
    async embedPassages(texts, o) {
      const vectors: Float32Array[] = [];
      if (closed || status !== 'ready') return UNAVAILABLE;
      for (let at = 0; at < texts.length; at += BATCH) {
        const r = await submit('passage', texts.slice(at, at + BATCH), o?.signal, undefined);
        if (!r.ok) return r;
        vectors.push(...r.vectors);
      }
      return { ok: true, vectors };
    },
    embedQuery: (text, o) => submit('query', [text], o?.signal, o?.timeoutMs ?? config.queryTimeoutMs),
    stats: () => {
      const cutoff = now() - MINUTE_MS;
      while (embedded.length > 0 && (embedded[0] as number) < cutoff) embedded.shift();
      return { threads: config.threads, queued: queue.length, chunksPerMinute: embedded.length };
    },
    async close() {
      if (closed) return;
      closed = true;
      status = 'unavailable';
      if (retry !== undefined) clearTimeout(retry);
      for (const task of queue.splice(0)) finish(task, UNAVAILABLE);
      const current = backend;
      backend = undefined;
      await current?.close();
    },
  };
}
