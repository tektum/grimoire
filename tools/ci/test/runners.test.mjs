import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Jobs run on GitHub's own runners. A RunsOn label (`runs-on=`, on the `runs-on:` line or in a list under it) is only for a job that cannot, and a pinned `ubuntu-NN.NN` is for one that needs it; each says why in a comment on the line above or beside it.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = path.join(root, '.github/workflows');
const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(path.join(dir, f), 'utf8').split('\n')]);

const code = (text) => text.replace(/\s#.*$/, ''); // the line without its trailing comment

test('no job asks for RunsOn without a reason next to it, in a one-line runs-on or a list under it', () => {
  const bare = [];
  for (const [file, lines] of workflows) {
    lines.forEach((text, i) => {
      if (text.trim().startsWith('#') || !/runs-on=/.test(code(text))) return;
      const reason = /#\s*RunsOn:/.test(text) || /#\s*RunsOn:/.test(lines[i - 1] ?? '');
      if (!reason) bare.push(`${file}:${String(i + 1)}`);
    });
  }
  assert.deepEqual(bare, []);
});

test('the guard sees what it is for: a RunsOn label in a block list, and in a .yaml file, is bare', () => {
  const lines = ['jobs:', '  j:', '    runs-on:', '      - runs-on=1234/runner=4cpu-linux-x64'];
  const found = lines.filter((text) => !text.trim().startsWith('#') && /runs-on=/.test(code(text)));
  assert.equal(found.length, 1);
  assert.ok(/\.ya?ml$/.test('x.yaml') && /\.ya?ml$/.test('x.yml') && !/\.ya?ml$/.test('x.yml.bak'));
});

test('a job of ci.yml pinned to another image than ubuntu-latest says why on the line above', () => {
  const bare = [];
  for (const [file, lines] of workflows.filter(([f]) => f === 'ci.yml')) {
    lines.forEach((text, i) => {
      if (!/^\s+runs-on:\s*ubuntu-\d/.test(text)) return;
      if (!/#\s*RUNNER:/.test(lines[i - 1] ?? '') && !/#\s*RUNNER:/.test(text)) bare.push(`${file}:${String(i + 1)}`);
    });
  }
  assert.deepEqual(bare, []);
});

test('the header of ci.yml states the rule', () => {
  const ci = readFileSync(path.join(dir, 'ci.yml'), 'utf8');
  assert.match(ci.split('\n').slice(0, 6).join('\n'), /ubuntu-latest/);
  assert.doesNotMatch(ci.split('\n').slice(0, 6).join('\n'), /runner=4cpu/);
});

test('the jobs that run Playwright stay on the Ubuntu its browsers get their system libraries for, until Playwright supports the latest', () => {
  const ci = readFileSync(path.join(dir, 'ci.yml'), 'utf8');
  for (const name of ['e2e-m5', 'e2e-web', 'e2e-web-browsers']) {
    const job = ci.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z0-9-]+:\\n|$)`))?.[0] ?? '';
    assert.match(job, /\n {4}runs-on: ubuntu-24\.04\n/, name);
    assert.match(job, /playwright install --with-deps/, name);
  }
});
