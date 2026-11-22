// The sign-in end-to-end test (`make test-m3`): the scenarios one after another, each in its own Node process, against the running stack started with compose.m3.yaml
// (app outside local mode, real Descope adapter, local key server); results in test-results/m3/. Later slices add scenarios to SCENARIOS.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { here } from '../support.ts';

export const SCENARIOS = ['sign-in-matrix'] as const;

function runScenario(name: string): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, 'm3', 'scenarios', `${name}.ts`)], { env: { ...process.env, E2E_RESULTS_DIR: process.env['E2E_RESULTS_DIR'] ?? 'test-results/m3' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
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
