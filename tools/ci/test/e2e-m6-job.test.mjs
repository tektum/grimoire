import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The exit test of the web client (M6) is gated in the merge gate piece by piece, not by one job named for it (docs/proof/m6-exit.md says which): the checks that need no stack run in
// `checks`, the browser run in Chromium goes on to the handshake and the production headers in `e2e-web`, and the two jobs are in `ci-required`.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const ci = readFileSync(`${root}.github/workflows/ci.yml`, 'utf8');
const job = (name) => ci.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z0-9-]+:\\n|$)`))?.[0] ?? '';
const at = (text, pattern) => text.search(pattern);

test('the job `checks` runs the list of scenarios and the check of the production build, after its build', () => {
  const checks = job('checks');
  const build = at(checks, /run: bun run build\n/);
  const m6 = at(checks, /run: make test-m6-static\n/);
  assert.ok(build > 0, 'the build step is found');
  assert.ok(m6 > build, 'the M6 checks come after the build (the production client needs the built workspace)');
  assert.match(checks.slice(m6 - 200, m6), /name: Static checks \(the list of scenarios of the M6 exit test and check:build\)/);
});

test('the job `e2e-web` goes on, after the browser specs, to the stack that requires the handshake and the production headers, in Chromium only, before it tears the stack down', () => {
  const web = job('e2e-web');
  const specs = at(web, /run: make test-web-e2e\n/);
  const handshake = at(web, /run: make test-m6-handshake\n/);
  const down = at(web, /run: make down-volumes\n/);
  assert.ok(specs > 0 && handshake > specs, 'the handshake run follows the specs');
  assert.ok(down > handshake, 'the stack is torn down after it, whatever happens (the step has `if: always()`)');
  assert.match(web.slice(down - 60, down), /if: always\(\)/);
});

test('both jobs are in the merge gate', () => {
  const needs = job('ci-required').split('needs:\n')[1]?.split('steps:')[0] ?? '';
  for (const name of ['checks', 'e2e-web', 'e2e-web-browsers']) assert.ok(needs.includes(`- ${name}\n`), `${name} is in the list of ci-required`);
});
