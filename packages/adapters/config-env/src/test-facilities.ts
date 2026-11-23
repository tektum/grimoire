import type { ConfigProblem } from './index.js';

/**
 * TEST FACILITIES: switches that exist only so scenarios can prove what they test: two for the `hostile-neighbour` scenario (the circuit breaker), one for the admission-order tests.
 *  GRIMOIRE_TEST_SLOW_CONVERT_MS=<ms>  a page whose text contains TEST_SLOW_MARKER takes that long to convert (other pages are unaffected);
 *  GRIMOIRE_TEST_DISABLE_BREAKER=1     the per-page conversion breaker never opens;
 *  GRIMOIRE_TEST_SLOW_LOAD=<page id>:<ms>  loading that one page from the database takes that much longer (every other page is unaffected).
 * Both are read once, here, at start-up (from the process environment when the caller passes none), and only the server's composition calls this. Outside local mode (so in the production image) setting
 * either one is a configuration error with a fixed line. Nothing reads them per conversion.
 */
export const TEST_SLOW_MARKER = 'GRIMOIRE-TEST-SLOW-PAGE-7f3c';
const SLOW = 'GRIMOIRE_TEST_SLOW_CONVERT_MS';
const NO_BREAKER = 'GRIMOIRE_TEST_DISABLE_BREAKER';
const SLOW_LOAD = 'GRIMOIRE_TEST_SLOW_LOAD';
const MAX_SLOW_MS = 600_000;

export interface TestFacilities {
  readonly problems: ConfigProblem[];
  readonly slowConvert?: { readonly ms: number; readonly marker: string };
  readonly breaker?: { readonly disabled: true };
  readonly slowLoad?: { readonly pageId: string; readonly ms: number };
}

export function parseTestFacilities(env: Readonly<Record<string, string | undefined>> | undefined, local: boolean): TestFacilities {
  env ??= process.env;
  const slow = env[SLOW] ?? '';
  const off = env[NO_BREAKER] ?? '';
  const load = env[SLOW_LOAD] ?? '';
  const problems: ConfigProblem[] = [];
  if (slow === '' && off === '' && load === '') return { problems };
  if (!local) {
    for (const [name, value] of [[SLOW, slow], [NO_BREAKER, off], [SLOW_LOAD, load]] as const) {
      if (value !== '') problems.push({ setting: name, rule: 'is a test facility: it is refused unless GRIMOIRE_LOCAL=1' });
    }
    return { problems };
  }
  let slowConvert: TestFacilities['slowConvert'];
  if (slow !== '') {
    const ms = /^\d{1,7}$/.test(slow) ? Number(slow) : 0;
    if (ms < 1 || ms > MAX_SLOW_MS) problems.push({ setting: SLOW, rule: `must be an integer from 1 to ${String(MAX_SLOW_MS)}` });
    else slowConvert = { ms, marker: TEST_SLOW_MARKER };
  }
  let breaker: TestFacilities['breaker'];
  if (off !== '') {
    if (off === '1') breaker = { disabled: true };
    else problems.push({ setting: NO_BREAKER, rule: 'must be 1 when set' });
  }
  let slowLoad: TestFacilities['slowLoad'];
  if (load !== '') {
    const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,7})$/.exec(load);
    const ms = m?.[2] === undefined ? 0 : Number(m[2]);
    if (m?.[1] === undefined || ms < 1 || ms > MAX_SLOW_MS) problems.push({ setting: SLOW_LOAD, rule: `must be <page id>:<milliseconds from 1 to ${String(MAX_SLOW_MS)}>` });
    else slowLoad = { pageId: m[1], ms };
  }
  return { problems, ...(slowConvert ? { slowConvert } : {}), ...(breaker ? { breaker } : {}), ...(slowLoad ? { slowLoad } : {}) };
}
