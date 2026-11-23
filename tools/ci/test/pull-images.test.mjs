import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The script is run against a fake `docker` on PATH (in a scratch folder next to this file: the system temp directory may be full): what it is asked, in order,
// is written to a log. No network, no real Docker.
const base = mkdtempSync(path.join(import.meta.dirname, 'work-'));
test.after(() => { rmSync(base, { recursive: true, force: true }); });
const script = path.join(import.meta.dirname, '..', 'pull-images.sh');

const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
if [ "$1" = info ]; then [ "$FAKE_DAEMON_DOWN" = 1 ] && exit 1; exit 0; fi
case "$1 $2" in
  "compose -p") if [ "$FAKE_COMPOSE_FAILS" = 1 ]; then exit 1; fi; for i in $FAKE_COMPOSE_IMAGES; do echo "$i"; done; exit 0 ;;
  "image inspect") for p in $FAKE_PRESENT; do [ "$p" = "$3" ] && exit 0; done; exit 1 ;;
  "pull --quiet") n=$(grep -c "^pull --quiet $3$" "$FAKE_LOG"); [ "$n" -gt "$FAKE_FAILS" ] && exit 0; exit 1 ;;
esac
exit 1
`;

function run({ composeImages = '', present = '', fails = 0, composeFails = false, dockerfile = '', daemonDown = false, args = [] }) {
  const dir = mkdtempSync(path.join(base, 'case-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(path.join(bin, 'docker'), 0o755);
  const log = path.join(dir, 'log');
  writeFileSync(log, '');
  const file = path.join(dir, 'Dockerfile');
  writeFileSync(file, dockerfile);
  const result = spawnSync('sh', [script, ...args], {
    encoding: 'utf8', cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_COMPOSE_IMAGES: composeImages, FAKE_PRESENT: present, FAKE_FAILS: String(fails), FAKE_COMPOSE_FAILS: composeFails ? '1' : '0', FAKE_DAEMON_DOWN: daemonDown ? '1' : '0', PULL_RETRY_DELAYS: '0 0 0', DOCKERFILE: file },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: result.status, out: result.stdout, err: result.stderr, pulls: calls.filter((c) => c.startsWith('pull ')).map((c) => c.slice('pull --quiet '.length)), calls };
}

test('images that are already present are not asked for again (an offline machine keeps working)', () => {
  const r = run({ composeImages: 'postgres:17 seaweedfs:4', present: 'postgres:17 seaweedfs:4' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.pulls, []);
});

test('a pull that fails twice and then succeeds is retried and the run passes', () => {
  const r = run({ composeImages: 'postgres:17', fails: 2 });
  assert.equal(r.status, 0);
  assert.deepEqual(r.pulls, ['postgres:17', 'postgres:17', 'postgres:17']);
  assert.match(r.err, /pull of postgres:17 failed \(attempt 1\)/);
});

test('a registry that never answers fails after exactly four attempts, with a message that says it is not a test failure', () => {
  const r = run({ composeImages: 'postgres:17', fails: 99 });
  assert.equal(r.status, 1);
  assert.equal(r.pulls.length, 4);
  assert.match(r.err, /image pull failed after 4 attempts: postgres:17/);
  assert.match(r.err, /not a test failure/);
});

test('one image that cannot be pulled does not stop the others from being tried', () => {
  const r = run({ composeImages: 'a:1 b:1', fails: 99 });
  assert.equal(r.status, 1);
  assert.equal(r.pulls.filter((p) => p === 'a:1').length, 4);
  assert.equal(r.pulls.filter((p) => p === 'b:1').length, 4);
});

test('images Compose builds (named grimoire-<service>) are never pulled; the external bases of the Dockerfile are, its own stages are not', () => {
  const r = run({
    composeImages: 'grimoire-app grimoire-migrate postgres:17',
    dockerfile: ['# comment', 'FROM oven/bun:1@sha256:aa AS bun', 'FROM --platform=linux/amd64 node:26-slim AS build', 'FROM bun AS again', 'FROM gcr.io/distroless/nodejs26:nonroot', 'COPY --from=build /x /y', ''].join('\n'),
  });
  assert.equal(r.status, 0);
  assert.deepEqual(r.pulls.sort(), ['gcr.io/distroless/nodejs26:nonroot', 'node:26-slim', 'oven/bun:1@sha256:aa', 'postgres:17'].sort());
});

test('Compose files that cannot be read are a real error, not a retry', () => {
  const r = run({ composeFails: true });
  assert.equal(r.status, 2);
  assert.deepEqual(r.pulls, []);
});

test('a Docker daemon that cannot be reached is a real error named as such, with no pull attempted and no retry wait', () => {
  const r = run({ composeImages: 'postgres:17', daemonDown: true });
  assert.equal(r.status, 2);
  assert.deepEqual(r.pulls, []);
  assert.match(r.err, /Docker daemon/);
  assert.doesNotMatch(r.err, /image pull failed/);
});

test('--no-bases leaves the Dockerfile alone, and service names limit what Compose is asked for (what `make db-up` starts)', () => {
  const r = run({
    composeImages: 'postgres:17', args: ['--no-bases', 'postgres', 'seaweedfs'],
    dockerfile: 'FROM oven/bun:1 AS bun\nFROM gcr.io/distroless/nodejs26:nonroot\n',
  });
  assert.equal(r.status, 0);
  assert.deepEqual(r.pulls, ['postgres:17']); // no base image of the Dockerfile
  assert.ok(r.calls.some((c) => /^compose -p grimoire config --images postgres seaweedfs$/.test(c)), r.calls.join(' | '));
});
