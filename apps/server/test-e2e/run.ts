// Runs the ten collaboration scenarios one after another, each in its own Node process (the exit test: `make test-m1`).
import { spawnWatched } from '@tektum/grimoire-test-support/harness';
import path from 'node:path';
import { here } from './support.ts';

export const SCENARIOS = ['convergence', 'read-only', 'bad-input', 'connection-cap', 'presence', 'restart', 'sigterm-flush', 'auth-retry', 'store-failure', 'origin'] as const;

/** Runs one scenario process; resolves with its exit code and stdout lines. */
export function runScenario(name: string, env: Record<string, string> = {}): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve) => {
    const child = spawnWatched([path.join(here, 'scenarios', `${name}.ts`)], { ...process.env, ...env }, ['ignore', 'pipe', 'inherit']);
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (code) => { resolve({ code: code ?? 1, lines: out.split('\n').filter((l) => l !== '') }); });
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const only = process.argv.slice(2);
  const names = only.length > 0 ? only : SCENARIOS;
  let failed = 0;
  for (const name of names) {
    const r = await runScenario(name);
    for (const l of r.lines) process.stdout.write(`${l}\n`);
    if (r.code !== 0) failed += 1;
  }
  process.exit(failed === 0 ? 0 : 1);
}
