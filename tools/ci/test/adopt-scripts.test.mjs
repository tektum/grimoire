import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The guards of the adoption run in two scripts, tested here by what they do: `aws` is a stub that answers with the JSON of the real API from files, so a database or a cluster that is
// not the stage's, an error of the API and a task that is slow are told apart by their effects (the exit code, what is printed, what is called), not by the text of the workflow. `sleep` is a
// stub that records its argument and returns at once: no outcome depends on how fast the machine is.
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
  writeFileSync(path.join(dir, 'bin/sleep'), '#!/usr/bin/env bash\necho "sleep $1" >> "$STUB_DIR/calls"\n');
  chmodSync(path.join(dir, 'bin/sleep'), 0o755);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  const run = (script, args, env = {}) => {
    const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, STUB_DIR: dir }, timeout: 20000 });
    return { code: r.status, out: r.stdout, err: r.stderr, calls: (() => { try { return readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n'); } catch { return []; } })() };
  };
  return { run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const host = (id) => `${id}.cabc123.us-east-1.rds.amazonaws.com`;
const db = (id, vpc = 'vpc-1') => ({ DBInstanceIdentifier: id, DBSubnetGroup: { VpcId: vpc }, Endpoint: { Address: host(id) } });
const arn = (name) => `arn:aws:ecs:us-east-1:111111111111:cluster/${name}`;
const TASKDEF = 'arn:aws:ecs:us-east-1:111111111111:task-definition/grimoire-staging-Server:7';
const PARAM = 'arn:aws:ssm:us-east-1:111111111111:parameter/sst/grimoire/staging/MigratorUrl';
const SECRET = 'S3cr3tPassw0rd';
// The connection string the migration container of the stage's service holds (an SSM SecureString): its host is the database the service connects to.
const url = (h) => `postgresql://grimoire_migrator:${SECRET}@${h}:5432/grimoire?sslmode=verify-full`;
const GOOD = (over = {}) => ({
  'rds-describe-db-instances.json': { DBInstances: [db('grimoire-staging-dbinstance-abc123'), db('grimoire-dev-dbinstance-zzz999')] },
  'rds-describe-db-clusters.json': { DBClusters: [] },
  'ecs-list-clusters.json': { clusterArns: [arn('grimoire-staging-ClusterCluster-kkr'), arn('grimoire-dev-ClusterCluster-bcz'), arn('other-ClusterCluster-x')] },
  'ecs-describe-services.json': { services: [{ taskDefinition: TASKDEF, networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-1'] } } }] },
  'ecs-describe-task-definition.json': { taskDefinition: { containerDefinitions: [{ name: 'app', secrets: [{ name: 'GRIMOIRE_DATABASE_URL', valueFrom: 'arn:aws:ssm:us-east-1:111111111111:parameter/other' }] }, { name: 'migrate', secrets: [{ name: 'GRIMOIRE_DATABASE_MIGRATION_URL', valueFrom: PARAM }] }] } },
  'ssm-get-parameter.json': url(host('grimoire-staging-dbinstance-abc123')),
  'ec2-describe-subnets.json': { Subnets: [{ VpcId: 'vpc-1' }] },
  ...over,
});
const aurora = (id, stage = 'staging', over = {}) => ({
  DBClusterIdentifier: id,
  Engine: 'aurora-postgresql',
  DBSubnetGroup: `${id}-subnets`,
  Endpoint: `${id}.cluster-cabc123.us-east-1.rds.amazonaws.com`,
  TagList: [{ Key: 'sst:app', Value: 'grimoire' }, { Key: 'sst:stage', Value: stage }],
  ...over,
});
// The same stage as GOOD, but its database is an Aurora cluster (found by the tags SST puts on what it makes, not by a name), no instance is left, and the service connects to the cluster.
const AURORA = (over = {}) => GOOD({
  'rds-describe-db-instances.json': { DBInstances: [db('grimoire-dev-dbinstance-zzz999')] },
  'rds-describe-db-clusters.json': { DBClusters: [aurora('grimoire-staging-dbcluster-q1'), aurora('grimoire-dev-dbcluster-q2', 'dev'), aurora('other-dbcluster-q3', 'staging', { TagList: [{ Key: 'sst:app', Value: 'other' }, { Key: 'sst:stage', Value: 'staging' }] }), aurora('grimoire-staging-mysql-q4', 'staging', { Engine: 'aurora-mysql' })] },
  'rds-describe-db-subnet-groups.json': { DBSubnetGroups: [{ VpcId: 'vpc-1' }] },
  'ssm-get-parameter.json': url(aurora('grimoire-staging-dbcluster-q1').Endpoint),
  ...over,
});

test('targets: the database of the stage is the one the service connects to, by exact name, and the other stage\'s are left alone', () => {
  const s = scenario(GOOD());
  try {
    const r = s.run(targets, ['staging']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `database=grimoire-staging-dbinstance-abc123\ndatabase_kind=instance\ncluster=${arn('grimoire-staging-ClusterCluster-kkr')}\n`);
    assert.ok(!r.out.includes(SECRET) && !r.err.includes(SECRET), 'the connection string is read for its host and never printed');
    const dev = scenario(GOOD({ 'ssm-get-parameter.json': url(host('grimoire-dev-dbinstance-zzz999')) }));
    try { assert.equal(dev.run(targets, ['dev']).out.split('\n')[0], 'database=grimoire-dev-dbinstance-zzz999'); } finally { dev.done(); }
  } finally { s.done(); }
});

test('targets: an Aurora cluster of the stage is found by the tags SST gives it, and a cluster of another stage, another app or another engine is not the stage\'s', () => {
  const s = scenario(AURORA());
  try {
    const r = s.run(targets, ['staging']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `database=grimoire-staging-dbcluster-q1\ndatabase_kind=cluster\ncluster=${arn('grimoire-staging-ClusterCluster-kkr')}\n`);
    assert.ok(r.calls.includes('rds describe-db-subnet-groups'), 'the network of a cluster is that of its subnet group');
  } finally { s.done(); }
});

test('targets: a cluster of another stage, of another app or of another engine is refused even when the service connects to it (each filter is what excludes it)', () => {
  // Each excluded cluster has an endpoint of its own, so with the service pointed at the stage's cluster it never matches whatever the filters say: point the service at the excluded one.
  for (const excluded of ['grimoire-dev-dbcluster-q2', 'other-dbcluster-q3', 'grimoire-staging-mysql-q4']) {
    const endpoint = `${excluded}.cluster-cabc123.us-east-1.rds.amazonaws.com`;
    const s = scenario(AURORA({ 'ssm-get-parameter.json': url(endpoint) }));
    try {
      const r = s.run(targets, ['staging']);
      assert.equal(r.code, 1, excluded);
      assert.equal(r.out, '', `${excluded}: nothing is printed`);
      assert.match(r.err, /that the service connects to .*, found: \[\]/, excluded);
    } finally { s.done(); }
  }
});

test('targets: with an instance and a cluster of the stage together (the overlap of a move) the one the service connects to is chosen, and the other is never snapshotted by mistake', () => {
  const both = (live) => scenario(AURORA({ 'rds-describe-db-instances.json': { DBInstances: [db('grimoire-staging-dbinstance-abc123')] }, 'ssm-get-parameter.json': url(live) }));
  const onInstance = both(host('grimoire-staging-dbinstance-abc123'));
  const onCluster = both(aurora('grimoire-staging-dbcluster-q1').Endpoint);
  const onNeither = both('somewhere.else.example.test');
  try {
    assert.match(onInstance.run(targets, ['staging']).out, /^database=grimoire-staging-dbinstance-abc123\ndatabase_kind=instance\n/);
    assert.match(onCluster.run(targets, ['staging']).out, /^database=grimoire-staging-dbcluster-q1\ndatabase_kind=cluster\n/);
    const r = onNeither.run(targets, ['staging']);
    assert.equal(r.code, 1);
    assert.match(r.err, /expected one database of the stage staging that the service connects to \(somewhere\.else\.example\.test\), found: \[\]/);
    assert.equal(r.out, '');
    assert.ok(!r.err.includes(SECRET));
  } finally { onInstance.done(); onCluster.done(); onNeither.done(); }
});

test('targets: a retained database of a replaced stage next to the live one is not chosen, and a service whose connection string names none of the stage\'s databases refuses', () => {
  const retained = scenario(GOOD({ 'rds-describe-db-instances.json': { DBInstances: [db('grimoire-staging-dbinstance-abc123'), db('grimoire-staging-dbinstance-old456')] }, 'ssm-get-parameter.json': url(host('grimoire-staging-dbinstance-old456')) }));
  try {
    assert.match(retained.run(targets, ['staging']).out, /^database=grimoire-staging-dbinstance-old456\n/, 'the service connects to that one, and that is the one whose data the task changes');
  } finally { retained.done(); }
});

test('targets: a service whose migration container has no connection string, or whose parameter cannot be read, refuses before anything is chosen', () => {
  const noSecret = scenario(GOOD({ 'ecs-describe-task-definition.json': { taskDefinition: { containerDefinitions: [{ name: 'migrate', secrets: [] }] } } }));
  const noParam = scenario(GOOD({ 'ssm-get-parameter.json': 'not a connection string' }));
  try {
    const a = noSecret.run(targets, ['staging']);
    assert.equal(a.code, 1);
    assert.match(a.err, /the migration container of the service of the stage staging has no GRIMOIRE_DATABASE_MIGRATION_URL/);
    assert.equal(a.out, '');
    const b = noParam.run(targets, ['staging']);
    assert.equal(b.code, 1);
    assert.match(b.err, /has no host/);
    assert.ok(!b.err.includes('not a connection string'));
  } finally { noSecret.done(); noParam.done(); }
});

test('targets: the answers of the API reach jq through a pipe, so an account with very many databases does not hit the limit of one argument', () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ ...db(`grimoire-other${String(i)}-dbinstance-x${String(i)}`), Padding: 'x'.repeat(400) }));
  assert.ok(JSON.stringify(many).length > 131072, 'more than the 128 KiB one argument can hold');
  const s = scenario(GOOD({ 'rds-describe-db-instances.json': { DBInstances: [...many, db('grimoire-staging-dbinstance-abc123')] } }));
  try {
    const r = s.run(targets, ['staging']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^database=grimoire-staging-dbinstance-abc123\n/);
  } finally { s.done(); }
});

test('targets: two ECS clusters, or none, refuse; names that only contain or extend the stage\'s are not the stage\'s', () => {
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
    assert.equal(exact.out, `database=grimoire-staging-dbinstance-abc123\ndatabase_kind=instance\ncluster=${arn('grimoire-staging-ClusterCluster-a')}\n`, 'staging2, a-extra and xgrimoire are not the stage\'s, so they neither count nor get chosen');
    const r = none.run(targets, ['staging']);
    assert.equal(r.code, 1);
    assert.match(r.err, /expected one cluster of the stage staging, found: \[\]/);
  } finally { two.done(); lookalike.done(); none.done(); }
});

test('targets: a database outside the network of the stage\'s service refuses, an instance or a cluster', () => {
  const instance = scenario(GOOD({ 'ec2-describe-subnets.json': { Subnets: [{ VpcId: 'vpc-2' }] } }));
  const cluster = scenario(AURORA({ 'rds-describe-db-subnet-groups.json': { DBSubnetGroups: [{ VpcId: 'vpc-9' }] } }));
  try {
    const r = instance.run(targets, ['staging']);
    assert.equal(r.code, 1);
    assert.match(r.err, /grimoire-staging-dbinstance-abc123 is not in the network of the service \(vpc-1 against vpc-2\)/);
    assert.equal(r.out, '');
    assert.match(cluster.run(targets, ['staging']).err, /grimoire-staging-dbcluster-q1 is not in the network of the service \(vpc-9 against vpc-1\)/);
  } finally { instance.done(); cluster.done(); }
});

test('targets: a service with no subnet, an API error and a bad stage name stop it', () => {
  const noSubnet = scenario(GOOD({ 'ecs-describe-services.json': { services: [{}] } }));
  const broken = scenario(GOOD({ 'rds-describe-db-instances.json': 'not json' }));
  try {
    assert.match(noSubnet.run(targets, ['staging']).err, /has no subnet/);
    assert.notEqual(broken.run(targets, ['staging']).code, 0);
    for (const bad of ['', 'Staging', 'a b', 'x.*', '../x']) assert.equal(noSubnet.run(targets, [bad]).code, 2, bad);
    assert.equal(noSubnet.run(targets, ['staging', 'instance']).code, 2, 'the kind is no longer an argument: the service says which database it is');
  } finally { noSubnet.done(); broken.done(); }
});

const snapshot = path.join(root, 'tools/adopt/snapshot.sh');

test('snapshot: an instance is snapshotted and a cluster is snapshotted as a cluster, and each waits for its own snapshot', () => {
  const s = scenario({ 'rds-create-db-snapshot.json': '"creating"', 'rds-create-db-cluster-snapshot.json': '"creating"', 'rds-wait.json': '' });
  try {
    const i = s.run(snapshot, ['instance', 'grimoire-staging-dbinstance-abc123', 'grimoire-staging-before-x']);
    assert.equal(i.code, 0, i.err);
    assert.deepEqual(i.calls, ['rds create-db-snapshot', 'rds wait']);
    assert.match(i.out, /snapshot grimoire-staging-before-x of instance grimoire-staging-dbinstance-abc123 is available/);
  } finally { s.done(); }
  const c = scenario({ 'rds-create-db-cluster-snapshot.json': '"creating"', 'rds-wait.json': '' });
  try {
    const r = c.run(snapshot, ['cluster', 'grimoire-staging-dbcluster-q1', 'grimoire-staging-before-x']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls, ['rds create-db-cluster-snapshot', 'rds wait']);
    assert.match(r.out, /snapshot grimoire-staging-before-x of cluster grimoire-staging-dbcluster-q1 is available/);
  } finally { c.done(); }
});

test('snapshot: a bad kind, an empty id and a bad snapshot name are usage errors that call nothing', () => {
  const s = scenario({});
  try {
    for (const args of [['database', 'id', 'snap'], ['instance', '', 'snap'], ['cluster', 'id', ''], ['cluster', 'id', '1bad'], ['cluster', 'id', 'a b']]) {
      const r = s.run(snapshot, args);
      assert.equal(r.code, 2, args.join(' '));
      assert.deepEqual(r.calls, []);
    }
  } finally { s.done(); }
});



const task = (lastStatus) => ({ tasks: [{ lastStatus }] });

const asCalls = (r) => r.calls.map((c) => c.split(' ')[0]);
const sleeps = (r) => r.calls.filter((c) => c.startsWith('sleep '));

test('wait-task: a task that is still on its way is polled with a pause until it stops', () => {
  const s = scenario({ 'tasks.1': task('PROVISIONING'), 'tasks.2': task('RUNNING'), 'tasks.3': task('DEPROVISIONING'), 'tasks.last': task('STOPPED') });
  try {
    const r = s.run(waitTask, ['cluster-arn', 'arn:aws:ecs:r:1:task/c/abc'], { ADOPT_POLL_SECONDS: '7' });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls.filter((c) => !c.startsWith('sleep')).length, 4);
    assert.deepEqual(sleeps(r), ['sleep 7', 'sleep 7', 'sleep 7']);
    assert.deepEqual(asCalls(r).slice(0, 2), ['ecs', 'sleep'], 'a poll, then a pause');
  } finally { s.done(); }
});

test('wait-task: an error of the API stops it at once, without a retry or a pause', () => {
  const s = scenario({ 'tasks.fail': '' });
  try {
    const r = s.run(waitTask, ['cluster-arn', 'task-arn'], { ADOPT_POLL_SECONDS: '5' });
    assert.notEqual(r.code, 0);
    assert.deepEqual(r.calls, ['ecs describe-tasks']);
    assert.match(r.err, /AccessDenied/);
  } finally { s.done(); }
});

const missing = { tasks: [], failures: [{ reason: 'MISSING' }] };

test('wait-task: a task ECS does not show yet is waited for, because it is eventually consistent, and then followed to its end', () => {
  const s = scenario({ 'tasks.1': missing, 'tasks.2': missing, 'tasks.3': task('PENDING'), 'tasks.last': task('STOPPED') });
  try {
    const r = s.run(waitTask, ['c', 'task-arn'], { ADOPT_POLL_SECONDS: '3', ADOPT_VISIBLE_POLLS: '5' });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.calls.filter((c) => !c.startsWith('sleep')).length, 4);
    assert.equal(sleeps(r).length, 3);
  } finally { s.done(); }
});

test('wait-task: a task that never shows stops after the polls of the window, naming it, and one that was seen and is gone stops at once', () => {
  const never = scenario({ 'tasks.last': missing });
  const byDefault = scenario({ 'tasks.last': missing });
  const gone = scenario({ 'tasks.1': task('RUNNING'), 'tasks.last': missing });
  try {
    const a = never.run(waitTask, ['c', 'task-arn'], { ADOPT_POLL_SECONDS: '3', ADOPT_VISIBLE_POLLS: '3' });
    assert.equal(a.code, 1);
    assert.match(a.err, /task-arn is not known to ECS \(never seen\)/);
    assert.equal(a.calls.filter((c) => !c.startsWith('sleep')).length, 4, 'the first poll and three more');
    assert.equal(sleeps(a).length, 3);
    const defaults = byDefault.run(waitTask, ['c', 'task-arn'], {});
    assert.equal(sleeps(defaults).length, 4, 'four polls of the window by default');
    assert.deepEqual([...new Set(sleeps(defaults))], ['sleep 15']);
    const b = gone.run(waitTask, ['c', 'task-arn'], { ADOPT_POLL_SECONDS: '3', ADOPT_VISIBLE_POLLS: '5' });
    assert.equal(b.code, 1);
    assert.match(b.err, /seen, then gone/);
    assert.equal(b.calls.filter((c) => !c.startsWith('sleep')).length, 2);
  } finally { never.done(); byDefault.done(); gone.done(); }
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
