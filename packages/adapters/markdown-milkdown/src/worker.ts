import { workerData } from 'node:worker_threads';
import { move, transferableSymbol, valueSymbol } from 'piscina';
import type { ConvertResult, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { convertInProcess } from './convert.js';
import type { ConverterLimits } from './limits.js';
import { seedInProcess } from './seed.js';

/** What the pool sends: bytes or Markdown, and the limits. Plain data only. */
export type WorkerRequest =
  | { op: 'to-markdown'; state: Uint8Array; limits: ConverterLimits }
  | { op: 'seed'; markdown: string; limits: ConverterLimits };

/** TEST FACILITY: present only when the pool was given `testSlow`; read once at worker start, never per conversion. */
const slow = ((): { marker: string; ms: number } | undefined => {
  const d: unknown = workerData;
  if (typeof d !== 'object' || d === null || !('testSlow' in d)) return undefined;
  const t: unknown = d.testSlow;
  if (typeof t !== 'object' || t === null || !('marker' in t) || !('ms' in t) || typeof t.marker !== 'string' || typeof t.ms !== 'number') return undefined;
  return { marker: t.marker, ms: t.ms };
})();

/** The worker entry piscina loads: runs the in-process functions; they never throw, so a failure is a typed result. */
export default async function run(request: WorkerRequest): Promise<ConvertResult | SeedResult | ReturnType<typeof move>> {
  if (request.op === 'to-markdown') {
    const result = await convertInProcess(request.state, request.limits);
    // Block the thread (as a pathological page would); the pool's timeout terminates this worker.
    if (slow && result.ok && result.markdown.includes(slow.marker)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slow.ms);
    return result;
  }
  const result = await seedInProcess(request.markdown, request.limits);
  if (!result.ok) return result;
  // Hand the seeded bytes back by moving their buffer, not copying it; a view into a larger buffer is copied out first.
  const { state } = result;
  const exact = state.byteOffset === 0 && state.buffer.byteLength === state.byteLength && state.buffer instanceof ArrayBuffer;
  const owned = exact ? state : new Uint8Array(state);
  return move({ [transferableSymbol]: owned.buffer, [valueSymbol]: { ok: true, state: owned } });
}
