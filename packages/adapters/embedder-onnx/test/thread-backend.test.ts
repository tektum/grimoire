import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createThreadBackend } from '../src/thread-backend.js';

const workerUrl = pathToFileURL(path.resolve(import.meta.dirname, 'support/stub-worker.mjs'));
const make = () => createThreadBackend({ workerUrl, threads: 1, dims: 4, maxTokens: 16 });
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
    expect(await b.embed('query', ['x'.repeat(20)])).toEqual({ ok: false, reason: 'too-long' });
    expect(await b.embed('query', ['broken'])).toEqual({ ok: false, reason: 'internal' });
    expect(await b.embed('passage', ['a']), 'the next call is served').toMatchObject({ ok: true });
    await b.close();
    await b.close();
    expect(await b.embed('query', ['a'])).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('counts a text on the thread, and says undefined when it cannot: before it is started, for a tokenizer that throws, for a thread that dies with the count waiting, and after it is closed', async () => {
    const b = make();
    expect(await b.count('one two')).toBeUndefined();
    let stopped = 0;
    b.onStopped(() => (stopped += 1));
    await b.start(files('ok'));
    expect(await b.count('one two three')).toBe(3);
    expect(await b.count('uncountable')).toBeUndefined();
    expect(await b.count('and again'), 'the next one is served').toBe(2);
    expect(await b.count('die')).toBeUndefined();
    await vi.waitFor(() => expect(stopped).toBe(1));
    await b.close();
    expect(await b.count('one two')).toBeUndefined();
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
