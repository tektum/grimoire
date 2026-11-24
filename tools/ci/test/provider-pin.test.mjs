import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
const workflow = read('.github/workflows/descope-infra.yml');

test('the plugins are installed with a checksum, into SST\'s home, before the job holds the AWS role or asks for the Descope token (the list and its versions: pulumi-plugins.test.mjs)', () => {
  const install = workflow.indexOf('plugin install resource "$name"');
  assert.ok(install > 0);
  const line = workflow.slice(install, workflow.indexOf('\n', install));
  assert.match(line, /--checksum "\$sha256"/);
  assert.match(line, /--reinstall/, 'without --reinstall an unchecked copy that is already installed would be kept');
  assert.match(workflow.slice(0, install), /PULUMI_HOME="\$HOME\/\.config\/sst"/);
  assert.ok(install < workflow.indexOf('configure-aws-credentials'));
  assert.ok(install < workflow.indexOf('getIDToken'));
});

test('credentials come from official actions only: AWS from aws-actions/configure-aws-credentials, the Descope token from actions/github-script', () => {
  assert.match(workflow, /uses: aws-actions\/configure-aws-credentials@[0-9a-f]{40} # v/);
  assert.match(workflow, /uses: actions\/github-script@[0-9a-f]{40} # v/);
  assert.doesNotMatch(workflow, /curl|ACTIONS_ID_TOKEN_REQUEST/, 'no hand-written token fetching');
});

test('the gate checks every variable a stage needs, the same ones for every stage, before the job assumes the AWS role or asks for the Descope token', () => {
  const start = workflow.indexOf('id: gate');
  const gate = workflow.slice(start, workflow.indexOf('uses: actions/checkout', start));
  for (const name of ['AWS_ROLE_ARN', 'AWS_REGION', 'KEY_ID', 'GRIMOIRE_DOMAIN', 'GRIMOIRE_ALLOWED_EMAIL_DOMAINS']) assert.match(gate, new RegExp(`\\b${name}\\b`), name);
  assert.doesNotMatch(gate, /"\$\{STAGE\}" =/, 'no stage is asked for different variables than another');
  assert.ok(workflow.indexOf('id: gate') < workflow.indexOf('configure-aws-credentials'));
  assert.ok(workflow.indexOf('id: gate') < workflow.indexOf('getIDToken'));
});
