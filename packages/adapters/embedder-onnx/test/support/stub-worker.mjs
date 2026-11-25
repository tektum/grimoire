// A stand-in for worker.js that speaks its messages with no model: `weights` says how it behaves, the ids of a call say what it does.
import { parentPort, workerData } from 'node:worker_threads';

const { weights, dims } = workerData;
if (weights === 'throws-at-start') throw new Error('cannot start');
if (weights === 'load-fails') {
  parentPort.postMessage({ type: 'load-failed' });
} else {
  parentPort.on('message', ({ id, rows }) => {
    // A row's first id says what the call does: 900 dies, 901 fails.
    const first = rows[0]?.[1];
    if (first === 900) process.exit(3);
    if (first === 901) return parentPort.postMessage({ type: 'result', id, result: { ok: false, reason: 'internal' } });
    const buffers = rows.map(() => new Float32Array(dims).fill(1 / Math.sqrt(dims)).buffer);
    parentPort.postMessage({ type: 'result', id, result: { ok: true, buffers, dims } }, buffers);
  });
  parentPort.postMessage({ type: 'ready' });
}
