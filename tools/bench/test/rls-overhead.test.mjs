import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The benchmark runs only by hand in CI, so a syntax error would otherwise surface on the day it is needed.
test('the benchmark script parses', () => {
  const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('../rls-overhead.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
