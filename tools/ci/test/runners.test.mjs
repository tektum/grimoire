import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Jobs run on GitHub's own runners. A RunsOn label (`runs-on=` in a `runs-on:` line) is only for a job that cannot, and says why in a comment on the line above or beside it.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = path.join(root, '.github/workflows');
const workflows = readdirSync(dir).filter((f) => f.endsWith('.yml')).map((f) => [f, readFileSync(path.join(dir, f), 'utf8').split('\n')]);

test('no job asks for RunsOn without a reason next to it', () => {
  const bare = [];
  for (const [file, lines] of workflows) {
    lines.forEach((text, i) => {
      if (!/^\s+runs-on:.*runs-on=/.test(text)) return;
      const reason = /#\s*RunsOn:/.test(text) || /#\s*RunsOn:/.test(lines[i - 1] ?? '');
      if (!reason) bare.push(`${file}:${String(i + 1)}`);
    });
  }
  assert.deepEqual(bare, []);
});

test('the header of ci.yml states the rule', () => {
  const ci = readFileSync(path.join(dir, 'ci.yml'), 'utf8');
  assert.match(ci.split('\n').slice(0, 6).join('\n'), /ubuntu-latest/);
  assert.doesNotMatch(ci.split('\n').slice(0, 6).join('\n'), /runner=4cpu/);
});
