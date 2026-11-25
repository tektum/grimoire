import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('the task and the CI step give actionlint the pinned shellcheck by name, and CI installs it', () => {
  const task = read('mise.toml').match(/\[tasks\.lint-workflows\][\s\S]*?(?=\n\[|$)/)?.[0] ?? '';
  assert.match(task, /actionlint -shellcheck \\"\$\(mise which shellcheck\)\\"/);
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /install_args: actionlint zizmor shellcheck\n/);
  assert.match(ci, /run: actionlint -shellcheck "\$\(mise which shellcheck\)"\n/);
  assert.doesNotMatch(ci, /run: actionlint\s*\n/, 'a bare `actionlint` is the form that skips the scripts');
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
