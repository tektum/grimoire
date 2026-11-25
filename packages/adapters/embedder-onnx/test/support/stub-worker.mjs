// A stand-in for worker.js that speaks its messages with no model: `weights` says how it behaves, a text says what a call does.
import { parentPort, workerData } from 'node:worker_threads';

const { weights, dims } = workerData;
if (weights === 'throws-at-start') throw new Error('cannot start');
if (weights === 'load-fails') {
  parentPort.postMessage({ type: 'load-failed' });
} else {
  parentPort.on('message', ({ id, texts }) => {
    const first = texts[0];
    if (first === 'die') process.exit(3);
    if (first === 'long') return parentPort.postMessage({ type: 'result', id, result: { ok: false, reason: 'too-long' } });
    if (first === 'broken') return parentPort.postMessage({ type: 'result', id, result: { ok: false, reason: 'internal' } });
    const buffers = texts.map(() => new Float32Array(dims).fill(1 / Math.sqrt(dims)).buffer);
    parentPort.postMessage({ type: 'result', id, result: { ok: true, buffers, dims } }, buffers);
  });
  parentPort.postMessage({ type: 'ready' });
}
