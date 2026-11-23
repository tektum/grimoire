import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJsonLogger } from '@tektum/grimoire-adapter-logger-json';
import { compose } from '../../src/composition.js';
import { createEventLog } from '../../src/events.js';
import { createRun } from '../../src/lifecycle/run.js';
import { Shutdown } from '../../src/lifecycle/shutdown.js';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { makeContext } from './support/context.js';
import { TEST_SLOW_MARKER, parseTestFacilities } from '@tektum/grimoire-adapter-config-env';

const root = path.resolve(import.meta.dirname, '../../../..');
const SLOW = 'GRIMOIRE_TEST_SLOW_CONVERT_MS';
const NOBREAKER = 'GRIMOIRE_TEST_DISABLE_BREAKER';
const SLOWLOAD = 'GRIMOIRE_TEST_SLOW_LOAD';
const PAGE_ID = '0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f11';

describe('test-only facilities: parse', () => {
  it('unset or empty: nothing is enabled and nothing is refused', () => {
    expect(parseTestFacilities({}, false)).toEqual({ problems: [] });
    expect(parseTestFacilities({ [SLOW]: '', [NOBREAKER]: '' }, false)).toEqual({ problems: [] });
  });

  it('local mode enables them', () => {
    expect(parseTestFacilities({ [SLOW]: '15000', [NOBREAKER]: '1' }, true)).toEqual({ problems: [], slowConvert: { ms: 15000, marker: TEST_SLOW_MARKER }, breaker: { disabled: true } });
  });

  it('the slow-load switch names one page and a delay: <page id>:<ms>', () => {
    expect(parseTestFacilities({ [SLOWLOAD]: `${PAGE_ID}:400` }, true)).toEqual({ problems: [], slowLoad: { pageId: PAGE_ID, ms: 400 } });
    for (const bad of ['400', `${PAGE_ID}`, `${PAGE_ID}:0`, `${PAGE_ID}:600001`, `not-a-page:400`, `${PAGE_ID}:4x`]) {
      expect(parseTestFacilities({ [SLOWLOAD]: bad }, true).problems, bad).toEqual([{ setting: SLOWLOAD, rule: 'must be <page id>:<milliseconds from 1 to 600000>' }]);
    }
  });

  it.each([[SLOW, '15000'], [NOBREAKER, '1'], [SLOWLOAD, `${PAGE_ID}:400`]])('%s outside local mode is refused with a fixed line that shows no value', (name, value) => {
    const r = parseTestFacilities({ [name]: value }, false);
    expect(r.problems).toEqual([{ setting: name, rule: 'is a test facility: it is refused unless GRIMOIRE_LOCAL=1' }]);
    expect(r.slowConvert).toBeUndefined();
    expect(r.breaker).toBeUndefined();
  });

  it.each([[SLOW, '0'], [SLOW, 'abc'], [SLOW, '700000'], [NOBREAKER, '0'], [NOBREAKER, 'yes']])('%s=%s is invalid and the rule shows no value', (name, value) => {
    const r = parseTestFacilities({ [name]: value }, true);
    expect(r.problems).toHaveLength(1);
    expect(JSON.stringify(r.problems)).not.toContain(`"${value}"`);
  });
});

describe('test-only facilities: refused at start-up outside local mode', () => {
  const nonLocal = {
    GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
    GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
    GRIMOIRE_DESCOPE_PROJECT_ID: 'P123',
    GRIMOIRE_DESCOPE_MANAGEMENT_KEY: 'mgmt-key-xyz',
    GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.com',
    GRIMOIRE_FIRST_ADMIN_EMAILS: 'admin@example.com',
  };

  it('compose refuses, run exits 2 with one fixed line and no listener', async () => {
    const lines: string[] = [];
    const log = createEventLog(createJsonLogger({ destination: { write: (l) => lines.push(l) } }));
    const c = compose({ ...nonLocal, [SLOW]: '15000' });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    let code: number | undefined;
    await createRun({ compose: () => ({ ...c, log }), exit: (n) => { code = n; } })();
    expect(code).toBe(2);
    const text = lines.join('');
    expect(text).toContain('server.config_invalid');
    expect(text).toContain('GRIMOIRE_TEST_SLOW_CONVERT_MS');
    expect(text).toContain('refused unless GRIMOIRE_LOCAL=1');
    expect(text).not.toContain('15000');
  });

  it('the same start-up in local mode accepts it', () => {
    const c = compose({ ...nonLocal, GRIMOIRE_LOCAL: '1', GRIMOIRE_DESCOPE_PROJECT_ID: '', GRIMOIRE_DESCOPE_MANAGEMENT_KEY: '', GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef', [SLOW]: '15000', [NOBREAKER]: '1' });
    if (!c.ok) throw new Error(c.issues.join('; '));
    void c.ctx.shutdown;
  });
});

describe('test-only facilities: where they may appear', () => {
  const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');

  it('the image does not set them, and the converter, the saver and the run loop never read them', () => {
    expect(read('Dockerfile')).not.toContain('GRIMOIRE_TEST_');
    const src = [read('apps/server/src/composition.ts'), read('packages/adapters/config-env/src/test-facilities.ts')].join('\n');
    expect(src).toContain('parseTestFacilities(');
    for (const f of ['packages/adapters/markdown-milkdown/src/pool.ts', 'packages/adapters/markdown-milkdown/src/worker.ts', 'packages/adapters/collab-hocuspocus/src/save.ts', 'apps/server/src/lifecycle/run.ts']) {
      expect(read(f), f).not.toMatch(/process\.env|GRIMOIRE_TEST_/);
    }
  });

  it('compose.yaml passes them with an empty default, only through the test target variables', () => {
    const compose = read('compose.yaml');
    expect(compose).toContain(`${SLOW}: "\${${SLOW}:-}"`);
    expect(compose).toContain(`${NOBREAKER}: "\${${NOBREAKER}:-}"`);
  });

  it('the hostile-neighbour scenario uses the sentinel the server knows', () => {
    expect(read('apps/server/test-e2e/m2/scenarios/hostile-neighbour.ts')).toContain(`'${TEST_SLOW_MARKER}'`);
  });
});

describe('test-only facilities: one start-up line when active (local mode)', () => {
  it('compose reports the active facilities and run logs exactly one warn line naming them; none active: no line', async () => {
    const local = { GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:1/grimoire', GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080', GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef' };
    const on = compose({ ...local, [NOBREAKER]: '1' });
    const off = compose(local);
    if (!on.ok || !off.ok) throw new Error('expected compositions');
    expect(on.ctx.testFacilities).toEqual(['breaker-disabled']);
    expect(off.ctx.testFacilities).toEqual([]);
    for (const h of [...on.ctx.shutdownHooks, ...off.ctx.shutdownHooks]) await h.run();
    for (const facilities of [['breaker-disabled'] as const, [] as const]) {
      const { ctx } = makeContext();
      const fresh = new Shutdown(ctx.clock);
      const logger = new FakeLogger();
      await createRun({ compose: () => ({ ok: true, ctx: { ...ctx, log: createEventLog(logger), shutdown: fresh, config: makeFakeConfig({ host: '127.0.0.1', port: 0 }), testFacilities: facilities } }), source: { onSignal: () => undefined, onFault: () => undefined }, exit: () => undefined })();
      await fresh.run(ctx.log, 'SIGTERM');
      const lines = logger.entries.filter((e) => e.event === 'server.test_facilities_active');
      expect(lines).toEqual(facilities.length > 0 ? [{ level: 'warn', event: 'server.test_facilities_active', fields: { facilities } }] : []);
    }
  });
});
