import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The gate after a deploy, tested by its effects: `aws` and `curl` are stubs that answer from sequences (one answer per call, the last one repeats), `sleep` returns at once, so no outcome depends on
// the speed of the machine.
const script = path.join(fileURLToPath(new URL('../../../', import.meta.url)), 'tools/deploy/wait-healthy.sh');
const CLUSTER = 'arn:aws:ecs:us-east-1:123456789012:cluster/grimoire-staging-ClusterCluster-abc123';

const STUB = (kind) => `#!/usr/bin/env bash
set -eu
dir="$STUB_DIR"
${kind === 'aws' ? `if [ "$1 $2" = "ecs list-clusters" ]; then cat "$dir/clusters.json"; exit 0; fi` : ''}
n=$(( $(cat "$dir/${kind}.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$dir/${kind}.n"
f="$dir/${kind}.$n"; [ -e "$f" ] || f="$dir/${kind}.last"
cat "$f"
`;
const service = (running, deployments) => JSON.stringify({ services: [{ runningCount: running, desiredCount: 1, deployments: deployments.map(([status, rolloutState]) => ({ status, rolloutState })) }] });
const HEALTHY = service(1, [['PRIMARY', 'COMPLETED']]);

function run(services, codes, env = {}, clusters = { clusterArns: [CLUSTER] }) {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'grimoire-gate-'));
  mkdirSync(path.join(dir, 'bin'));
  for (const [name, kind] of [['aws', 'aws'], ['curl', 'curl']]) { writeFileSync(path.join(dir, 'bin', name), STUB(kind)); chmodSync(path.join(dir, 'bin', name), 0o755); }
  writeFileSync(path.join(dir, 'bin/sleep'), '#!/usr/bin/env bash\n');
  chmodSync(path.join(dir, 'bin/sleep'), 0o755);
  writeFileSync(path.join(dir, 'clusters.json'), JSON.stringify(clusters));
  services.forEach((s, i) => writeFileSync(path.join(dir, `aws.${i + 1}`), s));
  writeFileSync(path.join(dir, 'aws.last'), services.at(-1));
  codes.forEach((c, i) => writeFileSync(path.join(dir, `curl.${i + 1}`), c));
  writeFileSync(path.join(dir, 'curl.last'), codes.at(-1));
  try {
    const r = spawnSync('bash', [script, 'staging', 'grimoire.example.test'], { encoding: 'utf8', env: { ...process.env, ...env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, STUB_DIR: dir } });
    return { code: r.status, out: r.stdout, err: r.stderr, polls: (() => { try { return Number(readFileSync(path.join(dir, 'curl.n'), 'utf8').trim()); } catch { return 0; } })() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a stage that serves, with one complete deployment and every task running, passes after three polls in a row', () => {
  const r = run([HEALTHY], ['200']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.polls, 3);
});

test('a load balancer with no target (readyz 503) while the rollout looks fine turns the run red, at the last poll and not before', () => {
  const r = run([HEALTHY], ['503'], { MAX_POLLS: '5' });
  assert.equal(r.code, 1);
  assert.equal(r.polls, 5);
  assert.match(r.err, /did not become healthy in 5 polls: readyz 503/);
});

test('the stalled rollout of the outage (the new deployment in progress with no task, the old one holding a pending task) is not healthy even when something answers 200', () => {
  const stalled = service(0, [['PRIMARY', 'IN_PROGRESS'], ['ACTIVE', 'COMPLETED']]);
  const r = run([stalled], ['200'], { MAX_POLLS: '4' });
  assert.equal(r.code, 1);
  assert.match(r.err, /did not become healthy in 4 polls/);
});

test('a rollout marked failed stops the gate at once, naming the deployment', () => {
  const r = run([service(0, [['PRIMARY', 'FAILED']])], ['503']);
  assert.equal(r.code, 1);
  assert.match(r.err, /the rollout of the stage staging failed/);
  assert.equal(r.polls, 0, 'before any readyz call: the answer is already known');
});

test('a service that recovers in the middle of the wait passes, and a flapping one does not count its good polls across a bad one', () => {
  const recovering = run([service(0, [['PRIMARY', 'IN_PROGRESS']]), HEALTHY], ['503', '200']);
  assert.equal(recovering.code, 0, recovering.err);
  const flapping = run([HEALTHY], ['200', '200', '503', '200', '200', '503'], { MAX_POLLS: '6' });
  assert.equal(flapping.code, 1, 'two good, a bad, two good, a bad: never three in a row');
});

test('a stage with no cluster, or with two, or a malformed argument is refused before any poll', () => {
  assert.equal(run([HEALTHY], ['200'], {}, { clusterArns: [] }).code, 1);
  assert.equal(run([HEALTHY], ['200'], {}, { clusterArns: [CLUSTER, CLUSTER.replace('abc123', 'def456')] }).code, 1);
  const bad = spawnSync('bash', [script, 'Staging!', 'x.test'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
