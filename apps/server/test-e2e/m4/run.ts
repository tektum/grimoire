// The milestone 4 end-to-end test (`make test-m4`): six scenarios one after another, each in its own Node process, against the running stack; results in test-results/m4/.
// Own spawn loop, like ../m2/run.ts: the collaboration runner looks for scenarios next to itself, and its scenario files are not to be edited.
import { spawnWatched } from '@tektum/grimoire-test-support/harness';
import path from 'node:path';
import { here } from '../support.ts';

export const SCENARIOS = ['config', 'limits', 'session'] as const;

function runScenario(name: string): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve) => {
    const child = spawnWatched([path.join(here, 'm4', 'scenarios', `${name}.ts`)], { ...process.env, E2E_RESULTS_DIR: process.env['E2E_RESULTS_DIR'] ?? 'test-results/m4' }, ['ignore', 'pipe', 'inherit']);
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (code) => { resolve({ code: code ?? 1, lines: out.split('\n').filter((l) => l !== '') }); });
  });
}

const only = process.argv.slice(2);
let failed = 0;
for (const name of only.length > 0 ? only : SCENARIOS) {
  const r = await runScenario(name);
  for (const l of r.lines) process.stdout.write(`${l}\n`);
  if (r.code !== 0) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
