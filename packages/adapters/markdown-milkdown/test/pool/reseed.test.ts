import { beforeAll, describe, expect, it } from 'vitest';
import { createMarkdownConverter } from '../../src/index.js';
import { stateFromDocJson } from '../../src/testing/states.js';
import { SHAPES } from '../../src/testing/hostile-shapes.js';
import { ensureBuilt } from './support.js';

beforeAll(() => { ensureBuilt(); });
const LIMIT_MS = 1_500;
const TOO_LONG = 'the Markdown took too long to convert';

describe('the system rebuild through the pool', () => {
  it('accepts Markdown the user seed refuses, with its own time limit', async () => {
    const c = createMarkdownConverter({ poolSize: 2 });
    try {
      const many = 'a\n\n'.repeat(5_000);
      expect(await c.seed(many, 'user')).toMatchObject({ ok: false, reason: 'too-large' });
      expect((await c.reseed(many, 'page-1')).ok).toBe(true);
      expect(c.options.reseedTimeoutMs).toBe(30_000);
    } finally { await c.close(); }
  }, 60_000);

  it('the user entry cannot be given the lenient limits: a third argument is ignored, and the user path reads only the user limits', async () => {
    const c = createMarkdownConverter({ poolSize: 1 });
    try {
      const seed = c.seed as unknown as (markdown: string, key: string, extra: unknown) => ReturnType<typeof c.seed>;
      expect(await seed('a\n\n'.repeat(5_000), 'user', { maxSeedLines: 1e9, maxReseedMarkdownBytes: 1e9 })).toMatchObject({ ok: false, reason: 'too-large' });
      // The operator's pool settings for the user path do not widen the system path either way.
      const strict = createMarkdownConverter({ poolSize: 1, maxSeedMarkdownBytes: 10, maxSeedLines: 1, maxSeedLineMarkers: 1 });
      try {
        expect(await strict.seed('x'.repeat(11), 'u')).toMatchObject({ ok: false, reason: 'too-large' });
        expect((await strict.reseed('x\n\ny\n\nz'.repeat(3), 'p')).ok).toBe(true);
      } finally { await strict.close(); }
    } finally { await c.close(); }
  }, 60_000);

  it('a reseed needs a key; a user and a page with the same id do not block each other; one rebuild per page at a time', async () => {
    const c = createMarkdownConverter({ poolSize: 2, reseedTimeoutMs: LIMIT_MS, seedTimeoutMs: LIMIT_MS });
    try {
      expect(await c.reseed('x', '')).toEqual({ ok: false, reason: 'internal', detail: 'no-key', message: 'This request could not be started because it was not identified. Try again; if it keeps happening, report it.' });
      const slow = c.reseed(']'.repeat(60_000), 'same-id');
      expect(await c.seed('# user\n', 'same-id')).toMatchObject({ ok: true });
      expect(await c.reseed('# again\n', 'same-id')).toEqual({ ok: false, reason: 'internal', detail: 'one-at-a-time', message: 'Another conversion for this page is still running. Try again in a moment.' });
      expect(await slow).toEqual({ ok: false, reason: 'timeout', detail: `${TOO_LONG} (limit ${LIMIT_MS} ms)`, message: `The text took longer than ${LIMIT_MS / 1000} seconds to convert, so it was not changed. Splitting the page into smaller pages may help.` });
    } finally { await c.close(); }
  }, 60_000);
});

describe('saving is bounded by its time limit, not by a delimiter budget', () => {
  it('a state whose Markdown the parser cannot verify in time ends as a timeout, the worker is replaced, the next save works', async () => {
    const shape = SHAPES.find((s) => s.name === 'closing brackets');
    if (!shape) throw new Error('shape');
    const state = await stateFromDocJson(shape.build(60_000));
    const c = createMarkdownConverter({ poolSize: 1, timeoutMs: LIMIT_MS });
    try {
      expect(await c.toMarkdown(state)).toEqual({ ok: false, reason: 'timeout', detail: 'the conversion exceeded its time limit', message: `This page took longer than ${LIMIT_MS / 1000} seconds to convert to Markdown. Your edit is kept; the Markdown copy was not updated.` });
      const small = await c.seed('# hi\n', 'k');
      if (!small.ok) throw new Error(small.detail);
      expect((await c.toMarkdown(small.state)).ok).toBe(true);
      expect(c.stats()).toEqual({ threads: 1, queued: 0 });
    } finally { await c.close(); }
  }, 60_000);
});
