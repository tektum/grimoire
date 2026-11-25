// Offline: no workflow uses the live check, and CI never calls the local make target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './helpers.mjs';

test('no workflow uses the live check or its environment', () => {
  for (const f of readdirSync(join(root, '.github/workflows'))) {
    assert.doesNotMatch(readFileSync(join(root, '.github/workflows', f), 'utf8'), /DESCOPE_DEV_|descope-live|m3-live|descope-dev/, f);
  }
});

test('the make target refuses under CI before reading .env.m3, and the env file is ignored', () => {
  const mk = readFileSync(join(root, 'Makefile'), 'utf8');
  const body = mk.split('\ntest-m3-live:')[1]?.split('\n\n')[0] ?? '';
  assert.match(body, /-n "\$\$CI" \]; then .*exit 2/);
  assert.match(body, /set -a; \. \.\/\.env\.m3; set \+a; node tools\/m3-live\/check\.mjs/);
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.env\.\*/m);
});

test('running the make target with CI set exits 2 and names CI (the CI check comes first, so no live call can happen)', () => {
  const r = spawnSync('make', ['test-m3-live'], { cwd: root, env: { PATH: process.env.PATH, CI: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CI is set/);
});
