// `make test-m3-mutation`: each protection the exit test relies on is broken on purpose from OUTSIDE the code under test (a setting of the recreated app, or a database row the
// scenario sets at its marked place) and its scenario must then FAIL, with exactly the expected failure line (a failure for another reason is not detection). Succeeds only if
// every mutation is detected. The app is recreated with its normal settings at the end.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { here, repoRoot, waitReady } from '../support.ts';
import { waitStack } from './support.ts';

const exec = promisify(execFile);

interface Mutation { readonly name: string; readonly env: Record<string, string>; readonly scenario: string; readonly expected: string; readonly what: string }
const MUTATIONS: readonly Mutation[] = [
  { name: 'recheck-off', env: { M3_RECHECK_SECONDS: '600' }, scenario: 'access-cutoff', what: 'the access re-check almost never runs', expected: 'FAIL access-cutoff: timed out: the suspended session to be closed' },
  { name: 'recheck-off', env: { M3_RECHECK_SECONDS: '600' }, scenario: 'session-expiry', what: 'the session round almost never runs', expected: 'FAIL session-expiry: timed out: the forged renewal: the session to be closed' },
  { name: 'caps-raised', env: { M3_MAX_SOCKETS_PER_USER: '1000' }, scenario: 'user-caps', what: 'the per-user socket cap is far above the test\'s', expected: 'FAIL user-caps: the fourth socket of one person is refused full-for-you: expected "full-for-you", got "read-write"' },
  { name: 'preauth-timeout-long', env: { M3_PREAUTH_TIMEOUT_SECONDS: '12' }, scenario: 'pre-sign-in', what: 'a socket may stay unsigned for 12 s', expected: 'FAIL pre-sign-in: the timeout is the configured 5 s (' },
  { name: 'open-closed-collection', env: {}, scenario: 'closed-collection', what: 'the closed collection gets a default permission', expected: 'FAIL closed-collection: a person with no entry to a closed collection is refused not-found: expected "not-found", got "read-write"' },
  { name: 'unsuspend', env: {}, scenario: 'sign-in-matrix', what: 'the suspended user is not suspended', expected: 'FAIL sign-in-matrix: suspended user: refused forbidden: expected "forbidden", got "read-write"' },
  { name: 'viewer-as-member', env: {}, scenario: 'read-only', what: 'the viewer has the member role', expected: 'FAIL read-only: viewer: expected a signed-in readonly client, got read-write' },
];

const recreate = async (env: Record<string, string>): Promise<void> => {
  await exec('docker', ['compose', '-p', 'grimoire', 'up', '-d', '--force-recreate', '--no-deps', '--wait', 'app'], { cwd: repoRoot, env: { ...process.env, ...env } });
  await waitReady();
  await waitStack();
};

async function run(m: Mutation): Promise<{ code: number; lines: string[] }> {
  const env = { ...process.env, M3_MUTATION: m.name, E2E_RESULTS_DIR: 'test-results/m3-mutation' };
  try {
    const r = await exec('node', [path.join(here, 'm3', 'run.ts'), m.scenario], { cwd: repoRoot, env, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, lines: r.stdout.split('\n') };
  } catch (e) {
    const out = typeof e === 'object' && e !== null && 'stdout' in e && typeof e.stdout === 'string' ? e.stdout : '';
    return { code: 1, lines: out.split('\n') };
  }
}

let ok = true;
let current: string | undefined;
try {
  for (const m of MUTATIONS) {
    const key = JSON.stringify(m.env);
    if (key !== current) { await recreate(m.env); current = key; }
    const r = await run(m);
    const line = r.lines.find((l) => l.startsWith('FAIL ') || l.startsWith('PASS '));
    for (const l of r.lines) if (l !== '') process.stdout.write(`${l}\n`);
    if (r.code !== 0 && line?.startsWith(m.expected) === true) process.stdout.write(`EXPECTED FAIL (${m.name}): ${m.scenario} fails when ${m.what}\n`);
    else { ok = false; process.stdout.write(`MUTATION NOT DETECTED (${m.name}): ${m.scenario} did not fail as expected when ${m.what} (exit ${String(r.code)}; first result line: ${line ?? 'none'})\n`); }
  }
} finally {
  await recreate({});
}
process.exit(ok ? 0 : 1);
