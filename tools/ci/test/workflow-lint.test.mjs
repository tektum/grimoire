import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The workflow lint must look at the shell scripts of the workflows. `actionlint` hands them to shellcheck only when it finds one on its PATH; without one it prints nothing and exits 0, so a bare
// `! cmd` (SC2251: it skips errexit, so the assertion can never fail) passed on a machine with no shellcheck and failed only in CI. The pinned shellcheck is named explicitly, in the task and in CI.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');

test('shellcheck is pinned with the other tools, down to the checksums of mise.lock', () => {
  assert.match(read('mise.toml'), /^shellcheck = "\d+\.\d+\.\d+"$/m);
  assert.match(read('mise.lock'), /\[\[tools\.shellcheck\]\]/);
  assert.match(read('mise.lock'), /\[tools\.shellcheck\."platforms\.linux-x64"\][^[]*checksum = "sha256:[0-9a-f]{64}"/);
});

test('the task and the CI step both run the script that names the pinned shellcheck, and CI installs it', () => {
  const task = read('mise.toml').match(/\[tasks\.lint-workflows\][\s\S]*?(?=\n\[|$)/)?.[0] ?? '';
  assert.match(task, /run = \["tools\/ci\/actionlint\.sh"/);
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /install_args: (?:gitleaks )?actionlint zizmor shellcheck\n/); // the secret scan shares the one install of the Checks job
  assert.match(ci, /run: tools\/ci\/actionlint\.sh\n/);
  assert.doesNotMatch(ci, /run: actionlint\b/, 'a bare `actionlint` is the form that skips the scripts');
  assert.match(read('tools/ci/actionlint.sh'), /actionlint -shellcheck "\$shellcheck"/);
});

/** The script run with a `mise` and an `actionlint` of the test's own on the PATH: what `mise which shellcheck` answers is the test's to say, and the stub actionlint records what it was given. */
function runScript({ mise, shellcheck }) {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'grimoire-actionlint-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const stub = (name, body) => {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    stub('mise', typeof mise === 'function' ? mise(dir) : mise);
    stub('actionlint', `echo "$@" > "${dir}/called"`);
    if (shellcheck) {
      writeFileSync(path.join(dir, 'shellcheck'), '#!/bin/sh\n');
      chmodSync(path.join(dir, 'shellcheck'), shellcheck === 'executable' ? 0o755 : 0o644);
    }
    const r = spawnSync('bash', [path.join(root, 'tools/ci/actionlint.sh'), 'a.yml'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
    let called;
    try {
      called = readFileSync(path.join(dir, 'called'), 'utf8').trim();
    } catch {
      called = undefined;
    }
    return { status: r.status, stderr: r.stderr, called, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the script hands actionlint the shellcheck that mise names, with the arguments it was given', () => {
  const r = runScript({ mise: (dir) => `echo "${dir}/shellcheck"`, shellcheck: 'executable' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.called, `-shellcheck ${r.dir}/shellcheck a.yml`);
});

test('the script fails, and does not run actionlint, when mise finds no shellcheck: it prints nothing, fails, or names a file that is not there or not executable', () => {
  for (const [what, mise, shellcheck] of [
    ['an empty answer with status 0', 'exit 0', undefined],
    ['a failure', 'echo "no such tool" >&2; exit 1', undefined],
    ['a path that is not there', 'echo /nonexistent/shellcheck', undefined],
    ['a file that is not executable', 'echo "$PWD/shellcheck"', 'plain'],
  ]) {
    const r = runScript({ mise, shellcheck });
    assert.notEqual(r.status, 0, what);
    assert.equal(r.called, undefined, `${what}: actionlint must not run without a shellcheck`);
  }
  const empty = runScript({ mise: 'exit 0', shellcheck: undefined });
  assert.match(empty.stderr, /pinned shellcheck was not found/);
});

const which = (tool) => {
  const r = spawnSync('mise', ['which', tool], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const actionlint = which('actionlint');
const shellcheck = which('shellcheck');
const needed = process.env.REQUIRE_LINT_TOOLS === '1';

test('a workflow with a bare `!` assertion fails the lint with the pinned shellcheck, and passes without a finding once it is an if', { skip: !needed && (actionlint === undefined || shellcheck === undefined) ? 'actionlint and shellcheck are not installed here (mise install); the workflow-policy job requires them' : false }, () => {
  assert.ok(actionlint && shellcheck, 'REQUIRE_LINT_TOOLS=1 and the tools are not installed');
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'grimoire-lint-'));
  try {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    const workflow = (script) => `name: t\non: push\npermissions: {}\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n${script.split('\n').map((l) => `          ${l}`).join('\n')}\n`;
    const lint = (script) => {
      const file = path.join(dir, '.github/workflows/t.yml');
      writeFileSync(file, workflow(script));
      return spawnSync(actionlint, ['-shellcheck', shellcheck, file], { cwd: dir, encoding: 'utf8' }); // the file by name: a directory that is no repository has no project for actionlint to find
    };
    // Not the last command: shellcheck leaves a final `!` alone, because the script's own status is then its result.
    const bare = lint('set -eu\n! grep -q cuda files.txt\necho checked');
    assert.equal(bare.status, 1, bare.stdout + bare.stderr);
    assert.match(bare.stdout, /SC2251/);
    const fixed = lint("set -eu\nif grep -q cuda files.txt; then echo 'a GPU library'; exit 1; fi\necho checked");
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
