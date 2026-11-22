// `make test-m1-mutation`: each limit raised in the running app must make its scenario FAIL; succeeds only if both do (R4.15, R4.16).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot, waitReady } from './support.ts';
import { runScenario } from './run.ts';

const exec = promisify(execFile);
const recreate = async (env: Record<string, string>): Promise<void> => {
  await exec('docker', ['compose', '-p', 'grimoire', 'up', '-d', '--force-recreate', '--no-deps', '--wait', 'app'], { cwd: repoRoot, env: { ...process.env, ...env } });
  await waitReady();
};
// The failure each raised limit must cause: the FAIL line must carry this text, so an unrelated failure is not counted as detection.
const mutations: readonly [string, Record<string, string>, string][] = [
  ['connection-cap', { GRIMOIRE_COLLAB_MAX_CONNECTIONS_PER_PAGE: '100000' }, 'timed out: the 101st connection to be refused'],
  ['bad-input', { GRIMOIRE_COLLAB_MAX_PAYLOAD_BYTES: '104857600' }, 'a 2 MB frame closes the socket with 1009'],
];
let ok = true;
try {
  for (const [name, env, expected] of mutations) {
    await recreate(env);
    const r = await runScenario(name, { E2E_RESULTS_DIR: 'test-results/m1-mutation' });
    for (const l of r.lines) process.stdout.write(`${l}\n`);
    if (!r.lines.some((l) => l.startsWith(`FAIL ${name}: ${expected}`)) || r.code === 0) { ok = false; process.stdout.write(`MUTATION NOT DETECTED: ${name}\n`); }
  }
} finally {
  await recreate({}); // back to the default limits
}
process.exit(ok ? 0 : 1);
