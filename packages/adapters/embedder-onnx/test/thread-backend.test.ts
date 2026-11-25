import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createThreadBackend } from '../src/thread-backend.js';

const workerUrl = pathToFileURL(path.resolve(import.meta.dirname, 'support/stub-worker.mjs'));
// The tokenizer of the embedder's thread, as a stand-in: the plain text (the prefix taken off) says what the call does, and a long text has more ids than the limit.
const encode = (text: string): number[] => {
  const plain = text.replace(/^(query|passage): /, '');
  if (plain === 'die') return [0, 900, 2];
  if (plain === 'broken') return [0, 901, 2];
  return plain.length > 12 ? Array.from({ length: plain.length }, () => 5) : [0, 5, 2];
};
const make = () => createThreadBackend({ workerUrl, threads: 1, dims: 4, maxTokens: 16, encode });
const files = (weights: string) => ({ weights, tokenizer: 'tokenizer.json' });

describe('the thread backend', () => {
  it('starts the thread, sends it a batch and gets the vectors back, in the order of the texts', async () => {
    const b = make();
    await b.start(files('ok'));
    const r = await b.embed('passage', ['a', 'b', 'c']);
    expect(r.ok && r.vectors.map((v) => v.length)).toEqual([4, 4, 4]);
    expect(r.ok && r.vectors[0]?.[0]).toBeCloseTo(0.5, 5);
    await b.close();
  });

  it('gives the thread refusals as they are, and answers unavailable before it is started and after it is closed', async () => {
    const b = make();
    expect(await b.embed('query', ['a'])).toEqual({ ok: false, reason: 'unavailable' });
    await b.start(files('ok'));
    // Refused here, before anything is sent: a text with more ids than the limit, and a text too long to fit whatever its ids are.
    expect(await b.embed('query', ['x'.repeat(20)])).toEqual({ ok: false, reason: 'too-long' });
    expect(await b.embed('passage', ['y'.repeat(16 * 64)])).toEqual({ ok: false, reason: 'too-long' });
    expect(await b.embed('query', ['broken'])).toEqual({ ok: false, reason: 'internal' });
    await b.close();
    await b.close();
    expect(await b.embed('query', ['a'])).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('rejects the start when the thread says it cannot load and when it dies before it is ready', async () => {
    const failing = make();
    await expect(failing.start(files('load-fails'))).rejects.toThrow('load-failed');
    await failing.close();
    const dying = make();
    await expect(dying.start(files('throws-at-start'))).rejects.toThrow('load-failed');
    await dying.close();
  });

  it('tells the embedder once when the thread stops after it was ready, and answers the call that was waiting with internal', async () => {
    const b = make();
    let stopped = 0;
    b.onStopped(() => (stopped += 1));
    await b.start(files('ok'));
    expect(await b.embed('passage', ['die'])).toEqual({ ok: false, reason: 'internal' });
    await vi.waitFor(() => expect(stopped).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped, 'once, though the thread ends with an error and an exit').toBe(1);
    await b.close();
  });

  it('does not tell the embedder of a thread it stopped itself', async () => {
    const b = make();
    let stopped = 0;
    b.onStopped(() => (stopped += 1));
    await b.start(files('ok'));
    await b.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopped).toBe(0);
  });
});
