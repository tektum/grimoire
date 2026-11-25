import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The freeze of a stage's service, tested by the calls it makes: `aws` is a stub that logs every call and answers the lookups from files.
const script = path.join(fileURLToPath(new URL('../../../', import.meta.url)), 'tools/deploy/freeze.sh');
const CLUSTER = 'arn:aws:ecs:us-east-1:123456789012:cluster/grimoire-dev-ClusterCluster-abc123';
const TARGET = '--service-namespace ecs --scalable-dimension ecs:service:DesiredCount --resource-id service/grimoire-dev-ClusterCluster-abc123/Server';
const STUB = `#!/usr/bin/env bash
set -eu
echo "$*" >> "$STUB_DIR/calls"
case "$1 $2" in
  "ecs list-clusters") cat "$STUB_DIR/clusters.json" ;;
  "ecs describe-services") cat "$STUB_DIR/desired" ;;
  "application-autoscaling describe-scalable-targets") cat "$STUB_DIR/min" ;;
esac
`;

function run(args, { clusters = [CLUSTER], desired = '1', min = '1' } = {}) {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'grimoire-freeze-'));
  mkdirSync(path.join(dir, 'bin'));
  writeFileSync(path.join(dir, 'bin/aws'), STUB);
  chmodSync(path.join(dir, 'bin/aws'), 0o755);
  writeFileSync(path.join(dir, 'clusters.json'), JSON.stringify({ clusterArns: clusters }));
  writeFileSync(path.join(dir, 'desired'), desired);
  writeFileSync(path.join(dir, 'min'), min);
  try {
    const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, STUB_DIR: dir } });
    const calls = (() => { try { return readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n'); } catch { return []; } })();
    return { code: r.status, err: r.stderr, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('freeze suspends the autoscaling first (its minimum would start a task again), then runs no task and waits until none runs', () => {
  const r = run(['freeze', 'dev']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls.slice(1), [
    `application-autoscaling register-scalable-target ${TARGET} --suspended-state DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=true`,
    `ecs update-service --cluster ${CLUSTER} --service Server --desired-count 0 --query service.desiredCount --output text`,
    `ecs wait services-stable --cluster ${CLUSTER} --services Server`,
  ]);
});

test('thaw restarts a frozen service at the autoscaling minimum, then resumes the autoscaling', () => {
  const r = run(['thaw', 'dev'], { desired: '0', min: '1' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls.slice(1), [
    `ecs describe-services --cluster ${CLUSTER} --services Server --query services[0].desiredCount --output text`,
    `application-autoscaling describe-scalable-targets --service-namespace ecs --resource-ids service/grimoire-dev-ClusterCluster-abc123/Server --query ScalableTargets[0].MinCapacity --output text`,
    `ecs update-service --cluster ${CLUSTER} --service Server --desired-count 1 --query service.desiredCount --output text`,
    `application-autoscaling register-scalable-target ${TARGET} --suspended-state DynamicScalingInSuspended=false,DynamicScalingOutSuspended=false,ScheduledScalingSuspended=false`,
  ]);
});

test('thaw leaves a running service as it is (every deploy thaws) and only resumes the autoscaling', () => {
  const r = run(['thaw', 'dev'], { desired: '1' });
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.calls.some((c) => c.startsWith('ecs update-service')), r.calls.join('\n'));
  assert.match(r.calls.at(-1), /register-scalable-target .*ScheduledScalingSuspended=false$/);
});

test('it refuses a stage without exactly one cluster, and a wrong call', () => {
  assert.equal(run(['freeze', 'dev'], { clusters: [] }).code, 1);
  const two = run(['freeze', 'dev'], { clusters: [CLUSTER, `${CLUSTER}x`] });
  assert.equal(two.code, 1);
  assert.equal(two.calls.length, 1, 'nothing is changed when the cluster is not certain');
  for (const args of [['stop', 'dev'], ['freeze'], ['freeze', 'Dev;']]) assert.equal(run(args).code, 2, args.join(' '));
});
