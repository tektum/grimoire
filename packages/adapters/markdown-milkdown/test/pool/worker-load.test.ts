import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMarkdownConverter, workerEntryPath } from '../../src/index.js';
import { ensureBuilt, FIXTURE_WORKER } from './support.js';

describe('the worker module is loaded by import(), never by require(esm)', () => {
  beforeAll(ensureBuilt);
  const converter = () => createMarkdownConverter({ workerPath: FIXTURE_WORKER, poolSize: 1 });

  it('piscina is given the CommonJS entry', () => {
    expect(workerEntryPath('file:///app/packages/x/dist/pool.js')).toBe('/app/packages/x/worker-entry.cjs');
    expect(workerEntryPath('file:///app/packages/x/src/pool.ts')).toBe('/app/packages/x/worker-entry.cjs');
  });

  const pools: ReturnType<typeof converter>[] = [];
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.close()));
  });

  it('the ES module is evaluated without a require on its stack', async () => {
    const c = converter();
    pools.push(c);
    const result = await c.seed('load-stack', 'k');
    if (!('state' in result)) throw new Error('no state');
    const stack = new TextDecoder().decode(result.state);
    expect(stack).toContain('behaviours.mjs');
    expect(stack).not.toMatch(/loadESMFromCJS|populateCJSExportsFromESM|Module\.require|Module\._load/);
  });
});
