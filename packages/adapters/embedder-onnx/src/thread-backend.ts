import { Worker } from 'node:worker_threads';
import type { EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import type { Backend, FromWorker, ToWorker, WorkerData } from './backend.js';
import { prepare } from './engine.js';

/**
 * The model in one worker thread of its own: it loads the weights, answers one batch of ids at a time (the texts are prefixed and tokenized here, on the embedder's thread), and takes nothing of the server's environment (secrets live there) or
 * flags. `workerUrl` is the compiled `worker.js`; the tests give it a stand-in that speaks the same messages.
 */
export function createThreadBackend(options: { readonly workerUrl: URL; readonly threads: number; readonly dims: number; readonly maxTokens: number; readonly encode: (text: string) => readonly number[] }): Backend {
  let worker: Worker | undefined;
  let nextId = 0;
  let stopped: (() => void) | undefined;
  let closed = false;
  const waiting = new Map<number, (result: EmbedResult) => void>();

  const fail = (): void => {
    for (const settle of waiting.values()) settle({ ok: false, reason: 'internal' });
    waiting.clear();
  };

  return {
    start(files) {
      return new Promise<void>((resolve, reject) => {
        const data: WorkerData = { weights: files.weights, threads: options.threads, dims: options.dims };
        const w = new Worker(options.workerUrl, { workerData: data, env: {}, execArgv: [] });
        worker = w;
        let started = false;
        w.on('message', (message: FromWorker) => {
          if (message.type === 'ready') {
            started = true;
            resolve();
          } else if (message.type === 'load-failed') {
            reject(new Error('load-failed'));
          } else {
            const settle = waiting.get(message.id);
            waiting.delete(message.id);
            if (message.result.ok) settle?.({ ok: true, vectors: message.result.buffers.map((b) => new Float32Array(b)) });
            else settle?.({ ok: false, reason: message.result.reason });
          }
        });
        let reported = false;
        const ended = (): void => {
          if (reported) return; // `error` and `exit` both come for a thread that dies
          reported = true;
          fail();
          if (!started) reject(new Error('load-failed'));
          else if (!closed) stopped?.();
        };
        w.on('error', ended);
        w.on('exit', ended);
      });
    },
    embed(kind, texts) {
      const w = worker;
      if (w === undefined || closed) return Promise.resolve<EmbedResult>({ ok: false, reason: 'unavailable' });
      // The tokenizer runs here, on the caller's thread: a throw of it is `internal`, not an exception that would leave the embedder's queue waiting for an answer that never comes (`embed` never rejects).
      let prepared: ReturnType<typeof prepare>;
      try {
        prepared = prepare(kind, texts, options.encode, options.maxTokens);
      } catch {
        return Promise.resolve<EmbedResult>({ ok: false, reason: 'internal' });
      }
      if (!prepared.ok) return Promise.resolve<EmbedResult>(prepared);
      return new Promise<EmbedResult>((resolve) => {
        nextId += 1;
        waiting.set(nextId, resolve);
        const message: ToWorker = { id: nextId, rows: prepared.rows };
        w.postMessage(message);
      });
    },
    onStopped(listener) {
      stopped = listener;
    },
    async close() {
      closed = true;
      fail();
      const w = worker;
      worker = undefined;
      await w?.terminate();
    },
  };
}
