// The model's thread (loaded by `thread-backend.ts`): thin on purpose, everything with a rule in it is in `engine.ts`. It holds the tokenizer, and nothing else does: the tokenizer is 160 MB of
// live objects, and on the server's own heap every full GC of them stops the event loop. It is proved by the container tests, which run the real models.
import { parentPort, workerData } from 'node:worker_threads';
import * as ort from 'onnxruntime-node';
import type { FromWorker, ToWorker, WorkerData } from './backend.js';
import { createRunner, prepare } from './engine.js';
import { loadTokenCounter } from './tokenizer.js';

const data = workerData as WorkerData;
const port = parentPort;
if (port === null) throw new Error('worker.js is a worker thread');
const send = (message: FromWorker, transfer: ArrayBuffer[] = []): void => port.postMessage(message, transfer);

try {
  const counter = loadTokenCounter(data.tokenizer);
  const session = await ort.InferenceSession.create(data.weights, { intraOpNumThreads: data.threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', executionProviders: ['cpu'] });
  const wantsTypeIds = session.inputNames.includes('token_type_ids');
  const engine = createRunner({
    async run({ ids, mask, batch, seqLen }) {
      const feeds: Record<string, ort.Tensor> = { input_ids: new ort.Tensor('int64', ids, [batch, seqLen]), attention_mask: new ort.Tensor('int64', mask, [batch, seqLen]) };
      if (wantsTypeIds) feeds['token_type_ids'] = new ort.Tensor('int64', new BigInt64Array(batch * seqLen), [batch, seqLen]);
      const out = await session.run(feeds);
      const hidden = out[session.outputNames[0] as string] as ort.Tensor;
      return { data: hidden.data as Float32Array, dims: hidden.dims[2] as number };
    },
  });
  port.on('message', (message: ToWorker) => {
    if (message.type === 'count') {
      let tokens: number | null = null;
      try {
        tokens = counter.count(message.text);
      } catch {
        // answered as null: the embedder uses its estimate for this text
      }
      return send({ type: 'count', id: message.id, tokens });
    }
    const failed = (reason: 'too-long' | 'internal'): void => send({ type: 'result', id: message.id, result: { ok: false, reason } });
    try {
      const prepared = prepare(message.kind, message.texts, counter.encode, data.maxTokens);
      if (!prepared.ok) return failed(prepared.reason);
      void engine.embedRows(prepared.rows).then((result) => {
        if (!result.ok) return failed('internal');
        const buffers = result.vectors.map((v) => v.buffer as ArrayBuffer);
        send({ type: 'result', id: message.id, result: { ok: true, buffers, dims: data.dims } }, buffers);
      });
    } catch {
      failed('internal');
    }
  });
  send({ type: 'ready' });
} catch {
  send({ type: 'load-failed' });
}
