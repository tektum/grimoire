import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
const workflow = read('.github/workflows/descope-infra.yml');

test('the plugin pinned in the workflow is the version sst.config.ts asks for, with a full sha256', () => {
  const version = /DESCOPE_PROVIDER_VERSION: "([^"]+)"/.exec(workflow)?.[1];
  const sha = /DESCOPE_PROVIDER_SHA256: "([^"]+)"/.exec(workflow)?.[1];
  assert.match(sha ?? '', /^[0-9a-f]{64}$/);
  const configured = /package: '@descope\/pulumi-descope', version: '([^']+)'/.exec(read('sst.config.ts'))?.[1];
  assert.equal(version, configured, 'the workflow pins another version than sst.config.ts uses: update both');
});

test('the plugin is installed with a checksum, into SST\'s home, before the job holds the AWS role or asks for the Descope token', () => {
  const install = workflow.indexOf('plugin install resource descope');
  assert.ok(install > 0);
  const line = workflow.slice(install, workflow.indexOf('\n', install));
  assert.match(line, /--checksum "\$DESCOPE_PROVIDER_SHA256"/);
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
