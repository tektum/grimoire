import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMarkdownConverter } from '@tektum/grimoire-adapter-markdown-milkdown';
import type { PooledMarkdownConverter } from '@tektum/grimoire-adapter-markdown-milkdown';
import { seedRefusalToHttp } from '../../src/http/seed-errors.js';

// The real worker pool: the key decides who may hold a worker, and the strict limits answer with the pool's own sentences.
let pool: PooledMarkdownConverter;
beforeAll(() => { pool = createMarkdownConverter({ poolSize: 2 }); });
afterAll(async () => { await pool.close(); });

const refusal = (r: Awaited<ReturnType<typeof pool.seed>>) => {
  if (r.ok) throw new Error('expected a refusal');
  return seedRefusalToHttp({ stage: 'seed', reason: r.reason, detail: r.detail, ...(r.message ? { message: r.message } : {}) });
};

describe('seed with the real pool', () => {
  it('gives one success and one 429 for two simultaneous calls with one user id', async () => {
    const [a, b] = await Promise.all([pool.seed('# one\n', 'user-1'), pool.seed('# two\n', 'user-1')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(refusal(a.ok ? b : a)).toMatchObject({ code: 'rate_limited', headers: { 'retry-after': '2' } });
  });

  it('lets two different user ids both succeed', async () => {
    const [a, b] = await Promise.all([pool.seed('# one\n', 'user-2'), pool.seed('# two\n', 'user-3')]);
    expect([a.ok, b.ok]).toEqual([true, true]);
  });

  it('answers 422 with the exact pool sentence for too many lines', async () => {
    const r = refusal(await pool.seed('a\n\n'.repeat(4_001), 'user-4'));
    expect(r).toEqual({ code: 'invalid', message: 'the Markdown has 8002 lines; the limit is 8000 lines' });
  });

  it('answers 422 with the exact pool sentence for 51 markers on a line', async () => {
    const r = refusal(await pool.seed(`${'> '.repeat(51)}x\n`, 'user-5'));
    expect(r).toEqual({ code: 'invalid', message: 'line 1 has 51 quote or list markers; the limit is 50 per line' });
  });
});
