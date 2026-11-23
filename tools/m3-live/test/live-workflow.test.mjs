// Offline: the opt-in live workflow cannot run on pull requests, pushes, schedules or forks, and CI never calls the local make target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers.mjs';

const wf = readFileSync(join(root, '.github/workflows/descope-live-m3.yml'), 'utf8');
const trigger = wf.match(/^on:\n((?: {2}.*\n|\n)+)/m)?.[1] ?? '';

test('its only trigger is a manual dispatch', () => {
  assert.deepEqual(trigger.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim()), ['workflow_dispatch:']);
  assert.doesNotMatch(wf, /pull_request|schedule:|push:|workflow_run|issue_comment/);
});

test('it has read-only permissions, no persisted credentials and a blocked gate before checkout', () => {
  assert.match(wf, /permissions:\n {2}contents: read/);
  assert.match(wf, /persist-credentials: false/);
  assert.ok(wf.indexOf('blocked=true') < wf.indexOf('actions/checkout'));
  assert.equal((wf.match(/steps\.gate\.outputs\.blocked != 'true'/g) ?? []).length, 3);
  for (const v of ['DESCOPE_DEV_PROJECT_ID', 'DESCOPE_DEV_TEST_LOGIN', 'DESCOPE_DEV_MANAGEMENT_KEY']) assert.match(wf, new RegExp(`\\[ -z "\\$\\{${v}\\}" \\]`));
});

test('the secret lives in an environment and is not used by any other workflow', () => {
  assert.match(wf, /environment: descope-dev/);
  for (const f of readdirSync(join(root, '.github/workflows')).filter((n) => n !== 'descope-live-m3.yml')) {
    assert.doesNotMatch(readFileSync(join(root, '.github/workflows', f), 'utf8'), /DESCOPE_DEV_|descope-live|m3-live/, f);
  }
});

test('the make target refuses without .env.m3 and under CI, and the env file is ignored', () => {
  const mk = readFileSync(join(root, 'Makefile'), 'utf8');
  const body = mk.split('\ntest-m3-live:')[1]?.split('\n\n')[0] ?? '';
  assert.match(body, /\.env\.m3/);
  assert.match(body, /CI/);
  assert.match(body, /exit 2/);
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.env\.\*/m);
});
