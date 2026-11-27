import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    env: { ...process.env, PLAYWRIGHT_CMD: bin, PLAYWRIGHT_RETRY_DELAYS: '0 0', PLAYWRIGHT_APT_CONF: '', PLAYWRIGHT_APT_SOURCES: '', PLAYWRIGHT_REPAIR_CMD: '', PLAYWRIGHT_ATTEMPT_TIMEOUT: '5', ...extra },
  });

test('installs the browsers, then the libraries, once each when nothing fails', () => {
  const f = fake({});
  const r = run(f.bin);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls(), ['install webkit firefox', 'install-deps webkit firefox']);
  assert.match(r.stdout, /::notice::Playwright webkit firefox: installed in \d+ s/);
});

test('a library step that fails twice (apt exit 100) is tried again and the job goes on', () => {
  const f = fake({ failing: 'install-deps', failures: 2 });
  const r = run(f.bin);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.calls().filter((c) => c.startsWith('install-deps')).length, 3);
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

/** A stand-in for `dpkg --configure -a` that logs its calls. */
function fakeRepair() {
  const bin = path.join(dir, 'fake-repair');
  const log = path.join(dir, 'repairs.log');
  writeFileSync(log, '');
  writeFileSync(bin, `#!/bin/sh\necho repaired >> "${log}"\n`);
  chmodSync(bin, 0o755);
  return { bin, count: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length };
}

test('dpkg is repaired before each retry of the libraries (a killed apt leaves it half done), and not for a retry of the browsers or when nothing failed', () => {
  const deps = fake({ failing: 'install-deps', failures: 2 });
  const repairDeps = fakeRepair();
  assert.equal(run(deps.bin, { PLAYWRIGHT_REPAIR_CMD: repairDeps.bin }).status, 0);
  assert.equal(repairDeps.count(), 2);

  const browsers = fake({ failing: 'install', failures: 2 });
  const repairBrowsers = fakeRepair();
  assert.equal(run(browsers.bin, { PLAYWRIGHT_REPAIR_CMD: repairBrowsers.bin }).status, 0);
  assert.equal(repairBrowsers.count(), 0);

  const clean = fake({});
  const repairClean = fakeRepair();
  assert.equal(run(clean.bin, { PLAYWRIGHT_REPAIR_CMD: repairClean.bin }).status, 0);
  assert.equal(repairClean.count(), 0);
});

test('the time for the whole install is bounded: when it is used up it stops trying and says so, instead of running into the budget of the job', () => {
  const f = fake({ failing: 'install', failures: 99, hang: true });
  const started = Date.now();
  // The first attempt ends at 1 s; 1 s is left, which is not more than the wait: no second attempt.
  const r = run(f.bin, { PLAYWRIGHT_TOTAL_SECONDS: '2', PLAYWRIGHT_ATTEMPT_TIMEOUT: '1', PLAYWRIGHT_RETRY_DELAYS: '1 1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /used up/);
  assert.match(r.stderr, /not a test failure/);
  assert.equal(f.calls().filter((c) => c.startsWith('install ')).length, 1, 'without the limit there would be three attempts');
  assert.ok(Date.now() - started < 8_000);
});

test('a repair of dpkg that stalls is cut by the time that is left of the total, and the wait is not slept past it', () => {
  const f = fake({ failing: 'install-deps', failures: 99 });
  const stall = path.join(dir, 'stalled-repair');
  writeFileSync(stall, '#!/bin/sh\nsleep 30\n');
  chmodSync(stall, 0o755);
  const started = Date.now();
  const r = run(f.bin, { PLAYWRIGHT_TOTAL_SECONDS: '4', PLAYWRIGHT_RETRY_DELAYS: '1 1', PLAYWRIGHT_REPAIR_CMD: stall });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a test failure/);
  assert.ok(Date.now() - started < 12_000, 'it did not wait for the 30 s repair');

  const slow = fake({ failing: 'install-deps', failures: 99 });
  const t1 = Date.now();
  const r2 = run(slow.bin, { PLAYWRIGHT_TOTAL_SECONDS: '2', PLAYWRIGHT_RETRY_DELAYS: '10 10' });
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /used up/);
  assert.ok(Date.now() - t1 < 8_000, 'it did not sleep the 10 s wait with 2 s left');
});

test('every apt source that names packages.microsoft.com is removed before the first apt call, whatever it is called, each one said, and the others are left', () => {
  const sources = path.join(dir, 'sources.list.d');
  mkdirSync(sources, { recursive: true });
  const host = 'deb [signed-by=/k.gpg] https://packages.microsoft.com/repos/x noble main\n';
  writeFileSync(path.join(sources, 'microsoft-prod.list'), host);
  writeFileSync(path.join(sources, 'azure-cli.list'), host);
  writeFileSync(path.join(sources, 'edge.sources'), 'Types: deb\nURIs: https://packages.microsoft.com/repos/edge\n');
  writeFileSync(path.join(sources, 'ubuntu.sources'), 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\n');
  writeFileSync(path.join(sources, 'microsoft-notes.list'), '# a name that says microsoft, a source that does not\n');
  const f = fake({});
  const r = run(f.bin, { PLAYWRIGHT_APT_SOURCES: sources });
  assert.equal(r.status, 0, r.stderr);
  for (const gone of ['microsoft-prod.list', 'azure-cli.list', 'edge.sources']) {
    assert.ok(!existsSync(path.join(sources, gone)), `${gone} is gone`);
    assert.match(r.stdout, new RegExp(`removed the apt source .*${gone.replace('.', '\\.')}`));
  }
  assert.ok(existsSync(path.join(sources, 'ubuntu.sources')) && existsSync(path.join(sources, 'microsoft-notes.list')), 'the others stay: the rule is the host, not the name');
  assert.deepEqual(f.calls(), ['install webkit firefox', 'install-deps webkit firefox']);
});

test('with no source naming packages.microsoft.com nothing is removed or said', () => {
  const sources = path.join(dir, 'clean.list.d');
  mkdirSync(sources, { recursive: true });
  writeFileSync(path.join(sources, 'ubuntu.sources'), 'URIs: http://archive.ubuntu.com/ubuntu\n');
  const r = run(fake({}).bin, { PLAYWRIGHT_APT_SOURCES: sources });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /removed the apt source/);
  assert.ok(existsSync(path.join(sources, 'ubuntu.sources')));
});

test('a source that cannot be removed is said so on stderr, never reported as removed, and the install still runs', { skip: process.getuid?.() === 0 && 'root can remove it' }, () => {
  const sources = path.join(dir, 'locked.list.d');
  mkdirSync(sources, { recursive: true });
  writeFileSync(path.join(sources, 'microsoft-prod.list'), 'deb https://packages.microsoft.com/repos/x noble main\n');
  chmodSync(sources, 0o555);
  try {
    const f = fake({});
    const r = run(f.bin, { PLAYWRIGHT_APT_SOURCES: sources, PLAYWRIGHT_SUDO: 'false' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /could not remove the apt source .*microsoft-prod\.list/);
    assert.doesNotMatch(r.stdout, /removed the apt source/);
    assert.ok(existsSync(path.join(sources, 'microsoft-prod.list')));
    assert.deepEqual(f.calls(), ['install webkit firefox', 'install-deps webkit firefox']);
  } finally {
    chmodSync(sources, 0o755);
  }
});
