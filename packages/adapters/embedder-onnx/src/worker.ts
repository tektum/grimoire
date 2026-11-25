// The model's thread (loaded by `thread-backend.ts`): thin on purpose, everything with a rule in it is in `engine.ts`. It is proved by the container tests, which run the real models.
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-node';
import type { FromWorker, ToWorker, WorkerData } from './backend.js';
import { createEngine } from './engine.js';

const data = workerData as WorkerData;
const port = parentPort;
if (port === null) throw new Error('worker.js is a worker thread');
const send = (message: FromWorker, transfer: ArrayBuffer[] = []): void => port.postMessage(message, transfer);

try {
  const tokenizer = new Tokenizer(JSON.parse(readFileSync(data.tokenizer, 'utf8')) as object, {});
  const session = await ort.InferenceSession.create(data.weights, { intraOpNumThreads: data.threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', executionProviders: ['cpu'] });
  const wantsTypeIds = session.inputNames.includes('token_type_ids');
  const engine = createEngine({
    encode: (text) => tokenizer.encode(text).ids,
    dims: data.dims,
    maxTokens: data.maxTokens,
    async run({ ids, mask, batch, seqLen }) {
      const feeds: Record<string, ort.Tensor> = { input_ids: new ort.Tensor('int64', ids, [batch, seqLen]), attention_mask: new ort.Tensor('int64', mask, [batch, seqLen]) };
      if (wantsTypeIds) feeds['token_type_ids'] = new ort.Tensor('int64', new BigInt64Array(batch * seqLen), [batch, seqLen]);
      const out = await session.run(feeds);
      const hidden = out[session.outputNames[0] as string] as ort.Tensor;
      return { data: hidden.data as Float32Array, dims: hidden.dims[2] as number };
    },
  });
  port.on('message', (message: ToWorker) => {
    void engine.embed(message.kind, message.texts).then((result) => {
      if (!result.ok) return send({ type: 'result', id: message.id, result: { ok: false, reason: result.reason === 'too-long' ? 'too-long' : 'internal' } });
      const buffers = result.vectors.map((v) => v.buffer as ArrayBuffer);
      send({ type: 'result', id: message.id, result: { ok: true, buffers, dims: data.dims } }, buffers);
    });
  });
  send({ type: 'ready' });
} catch {
  send({ type: 'load-failed' });
}
