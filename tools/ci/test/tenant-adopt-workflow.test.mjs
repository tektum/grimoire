import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The one-off that adopts the legacy workspace of a stage into a real tenant changes the data of the stage: it runs by hand, on main, in the stage's environment, after the person has typed the
// stage's name, and it passes nothing it was given to a shell as code.
const workflow = readFileSync(new URL('../../../.github/workflows/tenant-adopt.yml', import.meta.url), 'utf8');
const runs = [...workflow.matchAll(/\n\s+run: \|\n((?:\s{10,}.*\n?)+)/g)].map((m) => m[1]).join('\n');

test('it starts only by hand, on main, in the environment of the stage it is given, with no stored secret', () => {
  assert.match(workflow, /\non:\n\s+workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s+(push|pull_request|schedule):/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: \$\{\{ inputs\.stage \}\}/);
  assert.match(workflow, /uses: aws-actions\/configure-aws-credentials@[0-9a-f]{40} # v/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test('the person must type the stage name, and the tenant id, name and domain are checked before any credential is asked for', () => {
  assert.match(workflow, /\[ "\$\{CONFIRM\}" = "\$\{STAGE\}" \]/);
  assert.ok(workflow.indexOf('CONFIRM}" = "${STAGE}') < workflow.indexOf('configure-aws-credentials'));
  assert.match(workflow, /\^\[A-Za-z0-9_-\]\{1,128\}\$/, 'the same tenant id shape as the command and the database');
});

test('no input is written into a script: every one goes through an environment variable', () => {
  assert.doesNotMatch(runs, /\$\{\{/, 'a run block holds an expression');
  for (const name of ['TO', 'NAME', 'DOMAIN', 'STAGE', 'CONFIRM']) assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ inputs\\.`), name);
});

test('the command is the one of the migration step\'s container, from legacy, and the app container of the task exits at once', () => {
  assert.match(runs, /"tenant-adopt","--from","legacy","--to"/);
  assert.match(runs, /name: "migrate", command: \$args/);
  assert.match(runs, /name: "app", command: \["-e", "0"\]/);
  assert.match(runs, /wait tasks-stopped/);
  assert.match(runs, /exitCode/);
});

test('it shares the concurrency group of the deploys, so one stage is never deployed and adopted together', () => {
  assert.match(workflow, /concurrency:\n\s+group: descope-infra[^\n]*\n\s+cancel-in-progress: false/);
});
