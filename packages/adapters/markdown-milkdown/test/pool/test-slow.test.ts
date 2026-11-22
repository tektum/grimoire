import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMarkdownConverter, type PooledMarkdownConverter } from '../../src/pool.js';
import { ensureBuilt } from './support.js';

beforeAll(ensureBuilt);

const MARK = 'SENTINEL-SLOW-PAGE';
let pool: PooledMarkdownConverter | undefined;
afterEach(async () => { await pool?.close(); pool = undefined; });

async function stateOf(c: PooledMarkdownConverter, markdown: string): Promise<Uint8Array> {
  const s = await c.seed(markdown);
  if (!s.ok) throw new Error('seed failed');
  return s.state;
}

describe('the test-only slow conversion (a marker in the page text)', () => {
  it('a page carrying the marker converts past the timeout; a page without it does not', async () => {
    pool = createMarkdownConverter({ timeoutMs: 3_000, testSlow: { marker: MARK, ms: 60_000 } });
    const hostile = await stateOf(pool, `# Hostile\n\n${MARK}\n`);
    const plain = await stateOf(pool, '# Plain\n\nordinary\n');
    const t0 = Date.now();
    const slow = await pool.toMarkdown(hostile);
    expect(slow).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(30_000); // killed at the timeout, long before the 60 s the page asks for
    expect(await pool.toMarkdown(plain)).toMatchObject({ ok: true });
  }, 60_000); // the replacement worker starts cold: its first conversion must fit the pool timeout (3 s) on a loaded machine too

  it('without the option the marker means nothing', async () => {
    pool = createMarkdownConverter({ timeoutMs: 5_000 });
    const hostile = await stateOf(pool, `# Hostile\n\n${MARK}\n`);
    expect(await pool.toMarkdown(hostile)).toMatchObject({ ok: true });
  });

  it('refuses a non-positive delay or an empty marker', () => {
    expect(() => createMarkdownConverter({ testSlow: { marker: MARK, ms: 0 } })).toThrow(RangeError);
    expect(() => createMarkdownConverter({ testSlow: { marker: '', ms: 10 } })).toThrow(RangeError);
  });
});
