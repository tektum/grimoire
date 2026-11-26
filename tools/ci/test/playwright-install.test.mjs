import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const script = path.resolve(import.meta.dirname, '../playwright-install.sh');
const dir = mkdtempSync(path.join(tmpdir(), 'pw-install-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for `playwright`: logs each call, and fails the first `failures` calls of `failing` (a subcommand) or hangs on them when `hang` is set. */
function fake({ failing = '', failures = 0, hang = false }) {
  const bin = path.join(dir, 'fake-playwright');
  const log = path.join(dir, 'calls.log');
  const count = path.join(dir, 'count');
  writeFileSync(log, '');
  writeFileSync(count, '0');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = "${failing}" ]; then
  n=$(cat "${count}"); echo $((n + 1)) > "${count}"
  if [ "$n" -lt ${failures} ]; then ${hang ? 'sleep 30' : 'exit 100'}; fi
fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}
const run = (bin, extra = {}) =>
  spawnSync('sh', [script, 'webkit', 'firefox'], {
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_CMD: bin, PLAYWRIGHT_RETRY_DELAYS: '0 0', PLAYWRIGHT_APT_CONF: '', PLAYWRIGHT_ATTEMPT_TIMEOUT: '5', ...extra },
  });

test('installs the browsers, then the libraries, once each when nothing fails', () => {
  const f = fake({});
  const r = run(f.bin);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls(), ['install webkit firefox', 'install-deps webkit firefox']);
  assert.match(r.stdout, /::notice::Playwright webkit firefox: installed in \d+ s \(browser cache hit: false\)/);
});

test('a library step that fails twice (apt exit 100) is tried again and the job goes on', () => {
  const f = fake({ failing: 'install-deps', failures: 2 });
  const r = run(f.bin, { PLAYWRIGHT_CACHE_HIT: 'true' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.calls().filter((c) => c.startsWith('install-deps')).length, 3);
  assert.match(r.stdout, /browser cache hit: true/);
});

test('three failures end it, naming the step and saying it is not a test failure', () => {
  const f = fake({ failing: 'install', failures: 9 });
  const r = run(f.bin);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /failed after 3 attempts/);
  assert.match(r.stderr, /not a test failure/);
  assert.deepEqual(f.calls(), ['install webkit firefox', 'install webkit firefox', 'install webkit firefox']);
});

test('an attempt that hangs is ended at the limit and tried again, not waited for', () => {
  const f = fake({ failing: 'install', failures: 1, hang: true });
  const started = Date.now();
  const r = run(f.bin, { PLAYWRIGHT_ATTEMPT_TIMEOUT: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 15_000, 'it did not wait for the 30 s hang');
  assert.equal(f.calls().filter((c) => c.startsWith('install ')).length, 2);
});

test('without a browser name it says how to use it and does nothing', () => {
  const r = spawnSync('sh', [script], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
