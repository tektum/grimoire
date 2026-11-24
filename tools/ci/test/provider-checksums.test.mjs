import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
const [line, ...others] = read('infra/provider-checksums.txt').trim().split('\n');

test('the pinned plugin is the version sst.config.ts asks for, as a linux-amd64 asset with a full sha256', () => {
  assert.deepEqual(others, []);
  const [sum, file] = line.split(/\s+/);
  assert.match(sum, /^[0-9a-f]{64}$/);
  const pinned = /^pulumi-resource-descope-v(\d+\.\d+\.\d+)-linux-amd64\.tar\.gz$/.exec(file);
  assert.ok(pinned, file);
  const configured = /package: '@descope\/pulumi-descope', version: '([^']+)'/.exec(read('sst.config.ts'));
  assert.equal(pinned[1], configured?.[1], 'the checksum is for another version than sst.config.ts uses: update both');
});

test('the install script checks the checksum before it gives the file to Pulumi', () => {
  const script = read('infra/install-provider.sh');
  assert.ok(script.indexOf('sha256sum -c') > 0 && script.indexOf('sha256sum -c') < script.indexOf('plugin install'));
  assert.match(script, /set -eu/);
});

test('the workflow installs the plugin before the job holds the AWS role or asks for the Descope token', () => {
  const workflow = read('.github/workflows/descope-infra.yml');
  const install = workflow.indexOf('infra/install-provider.sh');
  assert.ok(install > 0);
  assert.ok(install < workflow.indexOf('configure-aws-credentials'));
  assert.ok(install < workflow.indexOf('getIDToken'));
});
