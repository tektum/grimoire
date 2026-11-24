import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The guards of the adoption run in two scripts, tested here by what they do: `aws` is a stub that answers with the JSON of the real API from files, so a database or a cluster that is
// not the stage's, an error of the API and a task that is slow are told apart by their effects (the exit code, what is printed, what is called), not by the text of the workflow.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const targets = path.join(root, 'tools/adopt/targets.sh');
const waitTask = path.join(root, 'tools/adopt/wait-task.sh');

const STUB = `#!/usr/bin/env bash
set -eu
dir="$STUB_DIR"
echo "$1 $2" >> "$dir/calls"
key="$1-$2"
if [ "$key" = "ecs-describe-tasks" ]; then
  n=$(( $(cat "$dir/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$dir/n"
  [ ! -e "$dir/tasks.fail" ] || { echo "An error occurred (AccessDenied)" >&2; exit 254; }
  f="$dir/tasks.$n"; [ -e "$f" ] || f="$dir/tasks.last"
  cat "$f"; exit 0
fi
cat "$dir/$key.json"
`;

function scenario(files) {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'grimoire-adopt-'));
  mkdirSync(path.join(dir, 'bin'));
  writeFileSync(path.join(dir, 'bin/aws'), STUB);
  chmodSync(path.join(dir, 'bin/aws'), 0o755);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  const run = (script, args, env = {}) => {
    const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, STUB_DIR: dir }, timeout: 20000 });
    return { code: r.status, out: r.stdout, err: r.stderr, calls: (() => { try { return readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n'); } catch { return []; } })() };
  };
  return { run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const db = (id, vpc = 'vpc-1') => ({ DBInstanceIdentifier: id, DBSubnetGroup: { VpcId: vpc } });
const arn = (name) => `arn:aws:ecs:us-east-1:111111111111:cluster/${name}`;
const GOOD = (over = {}) => ({
  'rds-describe-db-instances.json': { DBInstances: [db('grimoire-staging-dbinstance-abc123'), db('grimoire-dev-dbinstance-zzz999')] },
  'ecs-list-clusters.json': { clusterArns: [arn('grimoire-staging-ClusterCluster-kkr'), arn('grimoire-dev-ClusterCluster-bcz'), arn('other-ClusterCluster-x')] },
  'ecs-describe-services.json': { services: [{ networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-1'] } } }] },
  'ec2-describe-subnets.json': { Subnets: [{ VpcId: 'vpc-1' }] },
  ...over,
});

test('targets: the database and the cluster of the stage, by exact name, and the other stage\'s are left alone', () => {
  const s = scenario(GOOD());
  try {
    const r = s.run(targets, ['staging']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `instance=grimoire-staging-dbinstance-abc123\ncluster=${arn('grimoire-staging-ClusterCluster-kkr')}\n`);
    assert.equal(s.run(targets, ['dev']).out.split('\n')[0], 'instance=grimoire-dev-dbinstance-zzz999');
  } finally { s.done(); }
});

test('targets: two databases of the stage (a retained one of a replaced stage) refuse, name both, and ask nothing else', () => {
  const s = scenario(GOOD({ 'rds-describe-db-instances.json': { DBInstances: [db('grimoire-staging-dbinstance-abc123'), db('grimoire-staging-dbinstance-old456')] } }));
  try {
    const r = s.run(targets, ['staging']);
    assert.equal(r.code, 1);
    assert.match(r.err, /expected one database of the stage staging, found: \["grimoire-staging-dbinstance-abc123","grimoire-staging-dbinstance-old456"\]/);
    assert.equal(r.out, '');
    assert.deepEqual(r.calls, ['rds describe-db-instances']);
  } finally { s.done(); }
});

test('targets: two clusters, or none, refuse; names that only contain or extend the stage\'s are not the stage\'s', () => {
  const two = scenario(GOOD({ 'ecs-list-clusters.json': { clusterArns: [arn('grimoire-staging-ClusterCluster-a'), arn('grimoire-staging-ClusterCluster-b')] } }));
  const lookalike = scenario(GOOD({
    'rds-describe-db-instances.json': { DBInstances: [db('grimoire-staging-dbinstance-abc123'), db('grimoire-staging2-dbinstance-def')] },
    'ecs-list-clusters.json': { clusterArns: [arn('grimoire-staging-ClusterCluster-a'), arn('grimoire-staging-ClusterCluster-a-extra'), arn('xgrimoire-staging-ClusterCluster-b')] },
  }));
  const none = scenario(GOOD({ 'ecs-list-clusters.json': { clusterArns: [arn('grimoire-dev-ClusterCluster-bcz')] } }));
  try {
    assert.match(two.run(targets, ['staging']).err, /expected one cluster of the stage staging, found: \[/);
    const exact = lookalike.run(targets, ['staging']);
    assert.equal(exact.code, 0, exact.err);
    assert.equal(exact.out, `instance=grimoire-staging-dbinstance-abc123\ncluster=${arn('grimoire-staging-ClusterCluster-a')}\n`, 'staging2, a-extra and xgrimoire are not the stage\'s, so they neither count nor get chosen');
    const r = none.run(targets, ['staging']);
    assert.equal(r.code, 1);
    assert.match(r.err, /expected one cluster of the stage staging, found: \[\]/);
  } finally { two.done(); lookalike.done(); none.done(); }
});

test('targets: a database outside the network of the stage\'s service refuses', () => {
  const s = scenario(GOOD({ 'ec2-describe-subnets.json': { Subnets: [{ VpcId: 'vpc-2' }] } }));
  try {
    const r = s.run(targets, ['staging']);
    assert.equal(r.code, 1);
    assert.match(r.err, /grimoire-staging-dbinstance-abc123 is not in the network of the service \(vpc-1 against vpc-2\)/);
    assert.equal(r.out, '');
  } finally { s.done(); }
});

test('targets: a service with no subnet, an API error and a bad stage name stop it', () => {
  const noSubnet = scenario(GOOD({ 'ecs-describe-services.json': { services: [{}] } }));
  const broken = scenario(GOOD({ 'rds-describe-db-instances.json': 'not json' }));
  try {
    assert.match(noSubnet.run(targets, ['staging']).err, /has no subnet/);
    assert.notEqual(broken.run(targets, ['staging']).code, 0);
    for (const bad of ['', 'Staging', 'a b', 'x.*', '../x']) assert.equal(noSubnet.run(targets, [bad]).code, 2, bad);
  } finally { noSubnet.done(); broken.done(); }
});

const task = (lastStatus) => ({ tasks: [{ lastStatus }] });

test('wait-task: a task that is still on its way is polled with a pause until it stops, and the calls are the only ones made', () => {
  const s = scenario({ 'tasks.1': task('PROVISIONING'), 'tasks.2': task('RUNNING'), 'tasks.3': task('DEPROVISIONING'), 'tasks.last': task('STOPPED') });
  try {
    const started = Date.now();
    const r = s.run(waitTask, ['cluster-arn', 'arn:aws:ecs:r:1:task/c/abc'], { ADOPT_POLL_SECONDS: '0.2' });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls.length, 4);
    assert.ok(Date.now() - started >= 550, 'three pauses of 0.2 s');
  } finally { s.done(); }
});

test('wait-task: an error of the API stops it at once, without a retry or a pause', () => {
  const s = scenario({ 'tasks.fail': '' });
  try {
    const started = Date.now();
    const r = s.run(waitTask, ['cluster-arn', 'task-arn'], { ADOPT_POLL_SECONDS: '5' });
    assert.notEqual(r.code, 0);
    assert.equal(r.calls.length, 1);
    assert.ok(Date.now() - started < 3000, 'no pause was taken');
    assert.match(r.err, /AccessDenied/);
  } finally { s.done(); }
});

test('wait-task: a task ECS does not show yet is waited for, because it is eventually consistent, and then followed to its end', () => {
  const missing = { tasks: [], failures: [{ reason: 'MISSING' }] };
  const s = scenario({ 'tasks.1': missing, 'tasks.2': missing, 'tasks.3': task('PENDING'), 'tasks.last': task('STOPPED') });
  try {
    const r = s.run(waitTask, ['c', 'task-arn'], { ADOPT_POLL_SECONDS: '0.1', ADOPT_VISIBLE_SECONDS: '5' });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls.length, 4);
  } finally { s.done(); }
});

test('wait-task: a task that never shows stops after the window, naming it, and one that was seen and is gone stops at once', () => {
  const missing = { tasks: [], failures: [{ reason: 'MISSING' }] };
  const never = scenario({ 'tasks.last': missing });
  const gone = scenario({ 'tasks.1': task('RUNNING'), 'tasks.last': missing });
  try {
    const started = Date.now();
    const a = never.run(waitTask, ['c', 'task-arn'], { ADOPT_POLL_SECONDS: '0.1', ADOPT_VISIBLE_SECONDS: '0.5' });
    assert.equal(a.code, 1);
    assert.match(a.err, /task-arn is not known to ECS \(never seen\)/);
    assert.ok(a.calls.length >= 3 && a.calls.length <= 12, `${a.calls.length} calls`);
    assert.ok(Date.now() - started >= 450, 'the window was waited out');
    const b = gone.run(waitTask, ['c', 'task-arn'], { ADOPT_POLL_SECONDS: '0.1', ADOPT_VISIBLE_SECONDS: '5' });
    assert.equal(b.code, 1);
    assert.match(b.err, /seen, then gone/);
    assert.equal(b.calls.length, 2);
  } finally { never.done(); gone.done(); }
});

test('wait-task: a status it has never seen stops it with the status named, and a missing argument is a usage error', () => {
  const odd = scenario({ 'tasks.last': task('SOMETHING_NEW') });
  try {
    const b = odd.run(waitTask, ['c', 'task-arn'], { ADOPT_POLL_SECONDS: '5' });
    assert.equal(b.code, 1);
    assert.match(b.err, /unexpected status: SOMETHING_NEW/);
    assert.equal(b.calls.length, 1);
    assert.equal(odd.run(waitTask, [], {}).code, 2);
  } finally { odd.done(); }
});
