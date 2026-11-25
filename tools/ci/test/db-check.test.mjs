import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The read-only check of a stage's database (descope-infra.yml action=check), tested by what it asks ECS to run: `aws` is a stub that records the one-off task's
// arguments and answers the lookups from files, so nothing reaches AWS.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = path.join(root, 'tools/deploy/db-check.sh');
const CLUSTER = 'arn:aws:ecs:us-east-1:123456789012:cluster/grimoire-dev-ClusterCluster-abc123';
const TD = 'arn:aws:ecs:us-east-1:123456789012:task-definition/grimoire-dev-ClusterCluster-abc123-Server:7';
const TASK = 'arn:aws:ecs:us-east-1:123456789012:task/grimoire-dev-ClusterCluster-abc123/0123456789abcdef';
const NETWORK = { awsvpcConfiguration: { subnets: ['subnet-a'], securityGroups: ['sg-service'], assignPublicIp: 'ENABLED' } };
const STUB = `#!/usr/bin/env bash
set -eu
d="$STUB_DIR"
echo "$1 $2" >> "$d/calls"
case "$1 $2" in
  "ecs describe-services") cat "$d/service.json" ;;
  "ecs run-task")
    while [ $# -gt 0 ]; do case "$1" in --overrides) printf '%s' "$2" > "$d/overrides.json"; shift ;; --network-configuration) printf '%s' "$2" > "$d/network.json"; shift ;; --task-definition) printf '%s' "$2" > "$d/taskdef"; shift ;; esac; shift; done
    cat "$d/task" ;;
  "ecs describe-tasks") case "$*" in *--query*) cat "$d/exit" ;; *) echo '{"tasks":[{"lastStatus":"STOPPED"}]}' ;; esac ;;
  "ecs describe-task-definition") case "$*" in *awslogs-group*) echo /sst/cluster/x/migrate ;; *) echo grimoire-dev ;; esac ;;
  "logs get-log-events") printf '{"server_version":"17.9"}\\t{"rls_tables":15,"with_policies":15}\\n' ;;
esac
`;

function run(args, { task = TASK, exit = '0' } = {}) {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'grimoire-db-check-'));
  mkdirSync(path.join(dir, 'bin'));
  writeFileSync(path.join(dir, 'bin/aws'), STUB);
  chmodSync(path.join(dir, 'bin/aws'), 0o755);
  writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ taskDefinition: TD, networkConfiguration: NETWORK }));
  writeFileSync(path.join(dir, 'task'), task);
  writeFileSync(path.join(dir, 'exit'), exit);
  try {
    const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, STUB_DIR: dir, ADOPT_POLL_SECONDS: '0' } });
    const read = (f) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : undefined);
    return { code: r.status, out: r.stdout, err: r.stderr, overrides: read('overrides.json'), network: read('network.json'), taskdef: read('taskdef') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('it runs the check and nothing else as a task of the service: db-setup and the app exit at once, the migration container runs db-check.js', () => {
  const r = run([CLUSTER]);
  assert.equal(r.code, 0, r.err);
  const js = readFileSync(path.join(root, 'tools/deploy/db-check.js'), 'utf8');
  assert.deepEqual(JSON.parse(r.overrides), { containerOverrides: [{ name: 'db-setup', command: ['-e', '0'] }, { name: 'migrate', command: ['-e', js] }, { name: 'app', command: ['-e', '0'] }] });
  assert.equal(r.taskdef, TD, 'the task definition the service runs');
  assert.deepEqual(JSON.parse(r.network), NETWORK, 'the network of the service, so the task reaches the database');
  assert.match(r.out, /\{"server_version":"17\.9"\}\n\{"rls_tables":15,"with_policies":15\}/, 'what the check said');
});

test('it fails when the check did not finish or the task did not start, and refuses a wrong call', () => {
  assert.equal(run([CLUSTER], { exit: '1' }).code, 1);
  assert.equal(run([CLUSTER], { task: 'None' }).code, 1);
  for (const args of [[], ['grimoire-dev'], [`${CLUSTER};x`]]) assert.equal(run(args).code, 2, args.join(' '));
});

test('the check only reads: no statement in it writes, and it runs as the migration role, which row-level security does not filter', () => {
  const js = readFileSync(path.join(root, 'tools/deploy/db-check.js'), 'utf8');
  assert.doesNotMatch(js.replace(/^\s*\/\/.*$/gm, ''), /\b(insert|update|delete|alter|drop|create|truncate|grant|revoke)\b/i);
  assert.match(js, /GRIMOIRE_DATABASE_MIGRATION_URL/);
});
