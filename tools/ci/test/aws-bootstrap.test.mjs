import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../infra/bootstrap/aws-github-oidc.sh', import.meta.url));
const print = () => execFileSync('bash', [script, '123456789012', 'eu-west-1', '--print'], { encoding: 'utf8' });

/** The documents of `--print`: a heading line, then one JSON document, repeated. */
const documents = () => print().split(/^== (.*)\n/m).slice(1).reduce((all, part, i, parts) => (i % 2 === 0 ? [...all, [part, JSON.parse(parts[i + 1])]] : all), []);

test('prints four valid JSON documents with no placeholder left', () => {
  const out = print();
  assert.equal(documents().length, 4);
  assert.doesNotMatch(out, /__[A-Z]+__|REGION|ACCOUNT/);
});

test('each role trusts exactly its own environment of this repository, for AWS as the audience', () => {
  const trusts = documents().filter(([name]) => name.endsWith('trust policy'));
  assert.deepEqual(trusts.map(([name]) => name), ['role grimoire-deploy-descope-dev: trust policy', 'role grimoire-deploy-staging: trust policy']);
  const subjects = trusts.map(([, doc]) => doc.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub']);
  assert.deepEqual(subjects, ['repo:tektum/grimoire:environment:descope-dev', 'repo:tektum/grimoire:environment:staging']);
  for (const [, doc] of trusts) {
    assert.equal(doc.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
    assert.equal(doc.Statement[0].Principal.Federated, 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com');
  }
});

test('the Descope role can bootstrap SST state and nothing else: no wildcard deploy statement', () => {
  const permissions = Object.fromEntries(documents().filter(([name]) => name.endsWith('permissions')));
  const dev = permissions['role grimoire-deploy-descope-dev: permissions'].Statement;
  assert.ok(dev.every((s) => !s.Action.includes('*') && !s.Resource.includes('*')), 'no statement of the Descope role is a wildcard');
  assert.deepEqual(dev.map((s) => s.Sid).sort(), ['ManageBootstrapAssetBucket', 'ManageBootstrapECRRepo', 'ManageBootstrapSSMParameter', 'ManageBootstrapStateBucket', 'ManageSecrets']);
  assert.ok(permissions['role grimoire-deploy-staging: permissions'].Statement.some((s) => s.Sid === 'Deployments'), 'the staging role has the deploy statement');
});

test('the Descope role reaches only its own stage in SSM: not the passphrase or the secrets of staging', () => {
  const dev = documents().find(([name]) => name === 'role grimoire-deploy-descope-dev: permissions')[1].Statement;
  const resources = dev.flatMap((s) => s.Resource).filter((r) => r.includes(':parameter/'));
  assert.ok(resources.length >= 3);
  for (const r of resources) assert.match(r, /parameter\/sst\/(bootstrap$|passphrase\/grimoire\/descope-dev$|grimoire\/descope-dev\/\*$)/, r);
});

test('the JSON the README shows for an administrator is the JSON of the files the script uses', () => {
  const root = (path) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
  const shown = [...root('infra/README.md').matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  const readmeTrust = shown.find((doc) => doc.Statement[0].Action === 'sts:AssumeRoleWithWebIdentity');
  assert.deepEqual(readmeTrust, JSON.parse(root('infra/bootstrap/trust.json').replaceAll('__ACCOUNT__', 'ACCOUNT').replaceAll('__ENVIRONMENT__', '<environment>')), 'the trust policy of the README differs from trust.json');
  const dev = JSON.parse(root('infra/bootstrap/permissions-descope-dev.json').replaceAll('__ACCOUNT__', 'ACCOUNT').replaceAll('__REGION__', 'REGION'));
  assert.ok(shown.some((doc) => JSON.stringify(doc) === JSON.stringify(dev)), 'the Descope role permissions of the README differ from permissions-descope-dev.json');
});

test('refuses a wrong account id or region before calling anything', () => {
  const run = (...args) => spawnSync('bash', [script, ...args, '--print'], { encoding: 'utf8' });
  assert.equal(run('12345', 'eu-west-1').status, 2);
  assert.equal(run('123456789012', 'nowhere').status, 2);
});

test('an unknown option is refused instead of falling through to apply (a mistyped dry run must not change an account)', () => {
  const result = spawnSync('bash', [script, '123456789012', 'eu-west-1', '--pritn'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option/);
});
