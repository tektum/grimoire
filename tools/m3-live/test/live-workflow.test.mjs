// Offline: the opt-in live workflow cannot run on pull requests, pushes, schedules or forks, and CI never calls the local make target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './helpers.mjs';

const wf = readFileSync(join(root, '.github/workflows/descope-live-m3.yml'), 'utf8');
const trigger = wf.match(/^on:\n((?: {2}.*\n|#.*\n|\n)+)/m)?.[1] ?? '';

test('its only trigger is a manual dispatch', () => {
  assert.deepEqual(trigger.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim()), ['workflow_dispatch:']);
  assert.doesNotMatch(wf, /pull_request|schedule:|push:|workflow_run|issue_comment|repository_dispatch|workflow_call/);
});

test('it has read-only permissions, no persisted credentials and a blocked gate before checkout', () => {
  assert.match(wf, /permissions:\n {2}contents: read/);
  assert.match(wf, /persist-credentials: false/);
  const gate = wf.indexOf('blocked=true');
  assert.ok(gate >= 0 && gate < wf.indexOf('actions/checkout'));
  assert.equal((wf.match(/steps\.gate\.outputs\.blocked != 'true'/g) ?? []).length, 3);
  for (const v of ['DESCOPE_DEV_PROJECT_ID', 'DESCOPE_DEV_TEST_LOGIN', 'DESCOPE_DEV_MANAGEMENT_KEY']) assert.match(wf, new RegExp(`\\[ -z "\\$\\{${v}\\}" \\]`));
});

test('the secret lives in an environment and is not used by any other workflow', () => {
  assert.match(wf, /environment: descope-dev/);
  for (const f of readdirSync(join(root, '.github/workflows')).filter((n) => n !== 'descope-live-m3.yml')) {
    assert.doesNotMatch(readFileSync(join(root, '.github/workflows', f), 'utf8'), /DESCOPE_DEV_|descope-live|m3-live/, f);
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
