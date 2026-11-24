import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

test('refuses a wrong account id or region before calling anything', () => {
  const run = (...args) => spawnSync('bash', [script, ...args, '--print'], { encoding: 'utf8' });
  assert.equal(run('12345', 'eu-west-1').status, 2);
  assert.equal(run('123456789012', 'nowhere').status, 2);
});
