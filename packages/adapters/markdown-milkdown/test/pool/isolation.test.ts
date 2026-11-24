import { beforeAll, describe, expect, it } from 'vitest';
import { createMarkdownConverter } from '../../src/index.js';
import type { SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { ensureBuilt } from './support.js';

/** Parses for far longer than any limit used here (about 6 s of CPU on the reference machine; cost grows faster than its length). */
const SLOW = ']'.repeat(60_000);
const LIMIT_MS = 1_500;
const TOO_LONG = 'the Markdown took too long to convert';

beforeAll(() => { ensureBuilt(); });

const settled = <T>(p: Promise<T>): { done: () => boolean; value: Promise<T> } => {
  let done = false;
  const value = p.finally(() => { done = true; });
  return { done: () => done, value };
};

describe('options', () => {
  it('two workers and a 10 s seed limit by default; convert keeps its own 10 s', async () => {
    const c = createMarkdownConverter();
    try {
      expect(c.options).toMatchObject({ poolSize: 2, seedTimeoutMs: 10_000, timeoutMs: 10_000 });
    } finally { await c.close(); }
  });
  it('refuses a seed limit that is not a bounded positive integer', () => {
    for (const seedTimeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 32]) expect(() => createMarkdownConverter({ seedTimeoutMs })).toThrow(RangeError);
  });
});

describe('time is the bound for a seed', () => {
  it('stops a slow document at the seed limit with a clear result, replaces the worker, and the next one works', async () => {
    const c = createMarkdownConverter({ poolSize: 1, seedTimeoutMs: LIMIT_MS });
    try {
      const r = await c.seed(SLOW, 'a');
      expect(r).toEqual({ ok: false, reason: 'timeout', detail: `${TOO_LONG} (limit ${LIMIT_MS} ms)`, message: `The text took longer than ${LIMIT_MS / 1000} seconds to convert, so it was not changed. Splitting the page into smaller pages may help.` });
      const next = await c.seed('# hello\n', 'a');
      expect(next.ok).toBe(true);
      expect(c.stats()).toEqual({ threads: 1, queued: 0 });
    } finally { await c.close(); }
  }, 60_000);

  it.each([
    ['unmatched closing brackets', ']'.repeat(60_000)],
    ['unmatched emphasis and underscores, 30 KB', '*a_'.repeat(10_000)],
  ])('%s: stopped by the time limit, the worker replaced, the next seed works', async (_name, md) => {
    const c = createMarkdownConverter({ poolSize: 1, seedTimeoutMs: LIMIT_MS });
    try {
      expect(await c.seed(md, 'a')).toEqual({ ok: false, reason: 'timeout', detail: `${TOO_LONG} (limit ${LIMIT_MS} ms)`, message: `The text took longer than ${LIMIT_MS / 1000} seconds to convert, so it was not changed. Splitting the page into smaller pages may help.` });
      expect((await c.seed('# hello\n', 'a')).ok).toBe(true);
      expect(c.stats()).toEqual({ threads: 1, queued: 0 });
    } finally { await c.close(); }
  }, 60_000);

  it('does not shorten the convert limit: toMarkdown keeps timeoutMs', async () => {
    const c = createMarkdownConverter({ poolSize: 1, seedTimeoutMs: LIMIT_MS, timeoutMs: 20_000 });
    try {
      expect(c.options.timeoutMs).toBe(20_000);
      const state = (await c.seed('# hello\n', 'a')) as Extract<SeedResult, { ok: true }>;
      expect(await c.toMarkdown(state.state)).toMatchObject({ ok: true });
    } finally { await c.close(); }
  }, 60_000);
});

describe('one seed at a time per key', () => {
  it('refuses a second seed of the same key at once, never queues it, and lets another key through', async () => {
    const c = createMarkdownConverter({ poolSize: 2, seedTimeoutMs: LIMIT_MS });
    try {
      const first = settled(c.seed(SLOW, 'user-a'));
      const second = await c.seed('small', 'user-a');
      expect(second).toEqual({ ok: false, reason: 'internal', detail: 'one-at-a-time', message: 'Another conversion for this page is still running. Try again in a moment.' });
      expect(first.done()).toBe(false); // refused while the first still runs
      const other = await c.seed('# small\n', 'user-b'); // the other worker
      expect(other.ok).toBe(true);
      expect(first.done()).toBe(false); // a slow key never delayed another
      expect(await first.value).toMatchObject({ ok: false, reason: 'timeout' });
      expect((await c.seed('again', 'user-a')).ok).toBe(true); // the key is free again, also after a timeout
    } finally { await c.close(); }
  }, 60_000);

  it('the key is the user: two different pages with the same key are serialised; the same page under different keys is not', async () => {
    const c = createMarkdownConverter({ poolSize: 2, seedTimeoutMs: LIMIT_MS });
    try {
      const pageA = settled(c.seed(SLOW, 'user-1'));
      expect(await c.seed('# page B\n', 'user-1')).toEqual({ ok: false, reason: 'internal', detail: 'one-at-a-time', message: 'Another conversion for this page is still running. Try again in a moment.' });
      expect(pageA.done()).toBe(false);
      expect(await pageA.value).toMatchObject({ reason: 'timeout' });
      // The same page (the same Markdown) for two users: both are admitted, neither is refused as one-at-a-time.
      const first = settled(c.seed(SLOW, 'user-1'));
      const second = settled(c.seed(SLOW, 'user-2'));
      expect(await first.value).toMatchObject({ reason: 'timeout' });
      expect(await second.value).toMatchObject({ reason: 'timeout' });
    } finally { await c.close(); }
  }, 60_000);

  it('a key is free again after a refusal by the pre-check', async () => {
    const c = createMarkdownConverter({ poolSize: 2 });
    try {
      expect(await c.seed('a'.repeat(131_073), 'k')).toMatchObject({ ok: false, reason: 'too-large' });
      expect((await c.seed('fine', 'k')).ok).toBe(true);
    } finally { await c.close(); }
  }, 60_000);

  it('a key is required', async () => {
    const c = createMarkdownConverter({ poolSize: 2 });
    try {
      expect(await c.seed('x', '')).toEqual({ ok: false, reason: 'internal', detail: 'no-key', message: 'This request could not be started because it was not identified. Try again; if it keeps happening, report it.' });
      expect(await c.seed('x', undefined as unknown as string)).toEqual({ ok: false, reason: 'internal', detail: 'no-key', message: 'This request could not be started because it was not identified. Try again; if it keeps happening, report it.' });
      expect(await c.seed('x', 'k')).toMatchObject({ ok: true });
    } finally { await c.close(); }
  });
});

describe('residual limit: two hostile keys hold both workers', () => {
  it('a third key waits at most its wait limit, answers queue-timeout, and the pool recovers', async () => {
    const c = createMarkdownConverter({ poolSize: 2, seedTimeoutMs: LIMIT_MS });
    try {
      const a = settled(c.seed(SLOW, 'a'));
      const b = settled(c.seed(SLOW, 'b'));
      const third = await c.seed('# small\n', 'c');
      // Both workers are held for the whole limit, so the third key's wait limit ends first: it never started, and says nothing about its page.
      expect(third).toMatchObject({ ok: false, reason: 'queue-timeout' });
      expect(await a.value).toMatchObject({ reason: 'timeout' });
      expect(await b.value).toMatchObject({ reason: 'timeout' });
      expect((await c.seed('# after\n', 'c')).ok).toBe(true);
    } finally { await c.close(); }
  }, 60_000);
});
