// The sign-in end-to-end test (`make test-m3`): the scenarios one after another, each in its own Node process, against the running stack started with compose.m3.yaml
// (app outside local mode, real Descope adapter, local key server); results in test-results/m3/. Later slices add scenarios to SCENARIOS.
import { spawnWatched } from '@tektum/grimoire-test-support/harness';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { here, repoRoot } from '../support.ts';

export const SCENARIOS = ['sign-in-matrix', 'closed-collection', 'read-only', 'access-cutoff', 'session-expiry', 'user-caps', 'key-server-outage', 'database-outage', 'pre-sign-in'] as const;

function runScenario(name: string): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve) => {
    const child = spawnWatched([path.join(here, 'm3', 'scenarios', `${name}.ts`)], { ...process.env, E2E_RESULTS_DIR: process.env['E2E_RESULTS_DIR'] ?? 'test-results/m3' }, ['ignore', 'pipe', 'inherit']);
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (code) => { resolve({ code: code ?? 1, lines: out.split('\n').filter((l) => l !== '') }); });
  });
}

/** One informational line per scenario for the proof note: its duration and every numeric metric it recorded (a line that does not start with PASS or FAIL). */
function timings(name: string): string {
  try {
    const file = path.resolve(repoRoot, process.env['E2E_RESULTS_DIR'] ?? 'test-results/m3', `${name}.json`);
    const result: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const pairs = typeof result === 'object' && result !== null ? Object.entries(result).filter(([k, v]) => typeof v === 'number' && k !== 'assertions' && k !== 'seed') : [];
    return `TIMES ${name} ${pairs.map(([k, v]) => `${k}=${String(v)}`).join(' ')}`;
  } catch {
    return `TIMES ${name} unavailable`;
  }
}

const only = process.argv.slice(2);
let failed = 0;
for (const name of only.length > 0 ? only : SCENARIOS) {
  const r = await runScenario(name);
  for (const l of r.lines) process.stdout.write(`${l}\n`);
  process.stdout.write(`${timings(name)}\n`);
  if (r.code !== 0) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
