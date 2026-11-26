// A stand-in for worker.js that speaks its messages with no model and no tokenizer: `weights` says how it behaves, the text of a call says what it does.
import { parentPort, workerData } from 'node:worker_threads';

const { weights, dims, maxTokens } = workerData;
if (weights === 'throws-at-start') throw new Error('cannot start');
if (weights === 'load-fails') {
  parentPort.postMessage({ type: 'load-failed' });
} else {
  parentPort.on('message', (message) => {
    const { id } = message;
    if (message.type === 'count') {
      // 'die' dies, 'uncountable' is a tokenizer that throws (answered null), any other text counts its words.
      if (message.text === 'die') process.exit(3);
      const tokens = message.text === 'uncountable' ? null : message.text.split(/\s+/).filter((w) => w !== '').length;
      return parentPort.postMessage({ type: 'count', id, tokens });
    }
    const { texts } = message;
    // The first text says what the call does: 'die' dies, 'broken' fails; a text of more characters than maxTokens is too long.
    if (texts[0] === 'die') process.exit(3);
    if (texts[0] === 'broken') return parentPort.postMessage({ type: 'result', id, result: { ok: false, reason: 'internal' } });
    if (texts.some((t) => t.length > maxTokens)) return parentPort.postMessage({ type: 'result', id, result: { ok: false, reason: 'too-long' } });
    const buffers = texts.map(() => new Float32Array(dims).fill(1 / Math.sqrt(dims)).buffer);
    parentPort.postMessage({ type: 'result', id, result: { ok: true, buffers, dims } }, buffers);
  });
  parentPort.postMessage({ type: 'ready' });
}
