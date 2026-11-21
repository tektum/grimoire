import type { ConfigProblem } from './index.js';

/**
 * TEST FACILITIES: two switches that exist only so the `hostile-neighbour` scenario can prove it tests the circuit breaker.
 *  GRIMOIRE_TEST_SLOW_CONVERT_MS=<ms>  a page whose text contains TEST_SLOW_MARKER takes that long to convert (other pages are unaffected);
 *  GRIMOIRE_TEST_DISABLE_BREAKER=1     the per-page conversion breaker never opens.
 * Both are read once, here, at start-up (from the process environment when the caller passes none), and only the server's composition calls this. Outside local mode (so in the production image) setting
 * either one is a configuration error with a fixed line. Nothing reads them per conversion.
 */
export const TEST_SLOW_MARKER = 'GRIMOIRE-TEST-SLOW-PAGE-7f3c';
const SLOW = 'GRIMOIRE_TEST_SLOW_CONVERT_MS';
const NO_BREAKER = 'GRIMOIRE_TEST_DISABLE_BREAKER';
const MAX_SLOW_MS = 600_000;

export interface TestFacilities {
  readonly problems: ConfigProblem[];
  readonly slowConvert?: { readonly ms: number; readonly marker: string };
  readonly breaker?: { readonly disabled: true };
}

export function parseTestFacilities(env: Readonly<Record<string, string | undefined>> | undefined, local: boolean): TestFacilities {
  env ??= process.env;
  const slow = env[SLOW] ?? '';
  const off = env[NO_BREAKER] ?? '';
  const problems: ConfigProblem[] = [];
  if (slow === '' && off === '') return { problems };
  if (!local) {
    for (const [name, value] of [[SLOW, slow], [NO_BREAKER, off]] as const) {
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
  return { problems, ...(slowConvert ? { slowConvert } : {}), ...(breaker ? { breaker } : {}) };
}
