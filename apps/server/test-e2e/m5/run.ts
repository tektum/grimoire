// The milestone 5 end-to-end test (`make test-m5`): the scenarios one after another, each in its own Node process, against the running stack; results in test-results/m5/.
// Own spawn loop, like ../m4/run.ts. It names every scenario before it starts, and stops with exit 1 when the list and the scenario files differ.
import { spawnWatched } from '@tektum/grimoire-test-support/harness';
import path from 'node:path';
import { here } from '../support.ts';
import { SCENARIOS, listProblems } from './list.ts';

const dir = process.env['GRIMOIRE_M5_SCENARIOS_DIR'] ?? path.join(here, 'm5', 'scenarios');
const problems = listProblems(dir);
process.stdout.write(`scenarios: ${SCENARIOS.join(', ')}\n`);
for (const p of problems) process.stdout.write(`FAIL run list: ${p}\n`);
if (problems.length > 0 || process.argv.includes('--list')) process.exit(problems.length > 0 ? 1 : 0);

function runScenario(name: string): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve) => {
    const child = spawnWatched([path.join(dir, `${name}.ts`)], { ...process.env, E2E_RESULTS_DIR: process.env['E2E_RESULTS_DIR'] ?? 'test-results/m5' });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (code) => { resolve({ code: code ?? 1, lines: out.split('\n').filter((l) => l !== '') }); });
  });
}

let failed = 0;
for (const name of SCENARIOS) {
  const r = await runScenario(name);
  for (const l of r.lines) process.stdout.write(`${l}\n`);
  if (r.code !== 0) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
