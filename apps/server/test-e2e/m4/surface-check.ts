// The staleness check of the milestone 4 exit test (run by `make test-m4`): the API surface check must FAIL when docs/api-surface.txt no longer shows the build. It
// edits a COPY of the recorded surface (a response status of one operation) and runs the check on the copy: that must exit non-zero and name the difference; the real
// file passes. Prints `surface-check: ok` or `surface-check: <what failed>`, and exits 0 or 1.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runToEnd } from '@tektum/grimoire-test-support/harness';
import { repoRoot } from '../support.ts';

const EMIT = path.join(repoRoot, 'apps/server/dist/openapi/emit.js');
const RECORDED = path.join(repoRoot, 'docs/api-surface.txt');

async function main(): Promise<string | undefined> {
  const dir = path.join(repoRoot, 'test-results/m4/surface');
  mkdirSync(dir, { recursive: true });
  const same = path.join(dir, 'unchanged.txt');
  const stale = path.join(dir, 'stale.txt');
  copyFileSync(RECORDED, same);
  const lines = readFileSync(RECORDED, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith('GET /v1/config') && l.includes('res:200:'));
  if (at < 0) return 'the recorded surface has no GET /v1/config line to edit';
  lines[at] = (lines[at] ?? '').replace('res:200:', 'res:299:');
  writeFileSync(stale, lines.join('\n'));
  const fine = await runToEnd([EMIT, '--check-surface', same], {});
  if (fine.code !== 0) return `the unchanged surface was refused: ${fine.output.slice(-300)}`;
  const refused = await runToEnd([EMIT, '--check-surface', stale], {});
  if (refused.code === 0) return 'a stale surface passed the check';
  if (!refused.output.includes('GET /v1/config')) return `the stale surface was refused without naming the operation: ${refused.output.slice(-300)}`;
  return undefined;
}

const problem = await main().catch((error: unknown) => `could not run: ${error instanceof Error ? error.message : String(error)}`);
process.stdout.write(`surface-check: ${problem ?? 'ok'}\n`);
process.exit(problem === undefined ? 0 : 1);
