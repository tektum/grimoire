import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyAllow, check, findSleeps, staleEntries } from '../check-test-sleeps.mjs';

// The fixtures are written to a scratch directory inside this folder (the system temp directory may be full) and removed afterwards.
const base = mkdtempSync(path.join(import.meta.dirname, 'work-'));
test.after(() => { rmSync(base, { recursive: true, force: true }); });
const fixture = (name, text) => {
  mkdirSync(path.join(base, 'pkg/test'), { recursive: true });
  writeFileSync(path.join(base, 'pkg/test', name), text);
};
const run = (allow = []) => check(base, ['pkg'], allow).map((v) => `${path.basename(v.file)}:${String(v.ms)}`);

fixture('sleep-300.test.ts', "await sleep(300);\n");
fixture('timer-5000.test.ts', "await new Promise((resolve) => setTimeout(resolve, 5000));\n");
fixture('wait-11000.test.ts', "await new Promise<void>((r) => { setTimeout(r, 11_000); });\n");
fixture('ok.test.ts', [
  'await sleep(250);', 'await sleep(10);', 'await new Promise((r) => setTimeout(r, 100));',
  'await vi.waitFor(() => { expect(x).toBe(1); }, { timeout: 20_000 });',
  'vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(11_000);',
  "// await sleep(9000) in a comment",
  'async function sleep(ms: number): Promise<void> { return; }',
  '',
].join('\n'));

test('the check fails on a 300 ms sleep, a 5,000 ms timer promise and an 11,000 ms wait, and only on those', () => {
  assert.deepEqual(run().sort(), ['sleep-300.test.ts:300', 'timer-5000.test.ts:5000', 'wait-11000.test.ts:11000']);
});

test('250 ms and below, vi.waitFor, fake timers, comments and the helper definition pass', () => {
  assert.deepEqual(findSleeps('x.test.ts', 'await sleep(250);\nawait sleep(1);\nawait vi.waitFor(() => {});\nvi.advanceTimersByTime(9000);\n'), []);
});

test("Playwright's test.setTimeout(ms) is the test's own time limit, not a sleep; any other setTimeout is still checked", () => {
  assert.deepEqual(findSleeps('x.spec.ts', 'test.setTimeout(120_000);\ntest.setTimeout(30000);\n'), []);
  assert.deepEqual(findSleeps('x.spec.ts', 'await new Promise((r) => window.setTimeout(r, 5000));\n').map((v) => v.ms), [5000]);
  assert.deepEqual(findSleeps('x.spec.ts', 'await new Promise((r) => setTimeout(r, 5000));\n').map((v) => v.ms), [5000]);
  assert.deepEqual(findSleeps('x.spec.ts', 'somethingElse.setTimeout(120_000);\n').map((v) => v.kind), ['non-literal']);
});

test('an allow-list entry exempts a line only when it names the file, the line text and a reason', () => {
  const file = 'pkg/test/sleep-300.test.ts';
  const text = 'await sleep(300);';
  const v = [{ file, line: 1, text, ms: 300 }];
  assert.deepEqual(applyAllow(v, [{ file, line: text, reason: 'proves that nothing is sent' }]), []);
  assert.equal(applyAllow(v, [{ file, line: text, reason: '' }]).length, 1);
  assert.equal(applyAllow(v, [{ file, line: text }]).length, 1);
  assert.equal(applyAllow(v, [{ file: 'pkg/test/other.test.ts', line: text, reason: 'x' }]).length, 1);
  assert.equal(applyAllow(v, [{ file, line: 'await sleep(301);', reason: 'x' }]).length, 1);
  assert.equal(applyAllow(v, [{ line: text, reason: 'x' }]).length, 1);
  assert.deepEqual(run([{ file, line: text, reason: 'r' }]).sort(), ['timer-5000.test.ts:5000', 'wait-11000.test.ts:11000']);
});

test('a delay that is not a numeric literal is flagged, whatever the call shape', () => {
  const kinds = (text) => findSleeps('x.test.ts', text).map((v) => v.kind);
  assert.deepEqual(kinds('await sleep(DELAY_MS);'), ['non-literal']);
  assert.deepEqual(kinds('await sleep(n * 2);'), ['non-literal']);
  assert.deepEqual(kinds('await new Promise((r) => setTimeout(r, windowMs + 50));'), ['non-literal']);
  assert.deepEqual(kinds('await delay(ms);'), ['non-literal']);
  assert.deepEqual(kinds('await new Promise((r) => setTimeout(r, ms));'), ['non-literal']);
  assert.deepEqual(kinds('await sleep(5 * 10);'), []);
  assert.deepEqual(kinds('await sleep(250); await sleep(0.5); setTimeout(r, 1_0);'), []);
  assert.deepEqual(kinds('await sleep(300);'), ['literal-over-limit']);
});

test('setInterval is flagged until the line is allow-listed with a reason, and the result is listed', () => {
  const found = findSleeps('x.test.ts', 'const t = setInterval(tick, 20);');
  assert.deepEqual(found.map((v) => v.kind), ['interval']);
  assert.equal(applyAllow(found, [{ file: 'x.test.ts', line: 'const t = setInterval(tick, 20);', reason: 'drives the writer' }]).length, 0);
  assert.equal(applyAllow(found, [{ file: 'x.test.ts', line: 'const t = setInterval(tick, 20);', reason: '' }]).length, 1);
});

test('a setInterval whose arguments span several lines is still found', () => {
  assert.deepEqual(findSleeps('x.test.ts', 'const health = setInterval(() => {\n  poll();\n}, 250);').map((v) => v.kind), ['interval']);
});

test('a scan root that does not exist is skipped', () => {
  assert.deepEqual(check(base, ['no-such-dir'], []), []);
});

test('a call that spans several lines is read by syntax', () => {
  const text = 'await new Promise((resolve) =>\n  setTimeout(\n    resolve,\n    5000,\n  ),\n);\n';
  assert.deepEqual(findSleeps('x.test.ts', text).map((v) => [v.kind, v.ms]), [['literal-over-limit', 5000]]);
});

test('nesting depth does not hide a timer, and a sleep helper inside other calls is found', () => {
  assert.deepEqual(findSleeps('x.test.ts', 'setTimeout(() => { done(wrap(a, b(c(d)))); }, 5000);').map((v) => v.ms), [5000]);
  assert.deepEqual(findSleeps('x.test.ts', 'await Promise.all([run(wrap(sleep(5000)))]);').map((v) => v.ms), [5000]);
});

test('the delay of setTimeout is its second argument', () => {
  assert.deepEqual(findSleeps('x.test.ts', 'setTimeout(fn, 5000, 1);').map((v) => v.ms), [5000]);
  assert.deepEqual(findSleeps('x.test.ts', 'setTimeout(() => f(a, b), 300);').map((v) => v.ms), [300]);
  assert.deepEqual(findSleeps('x.test.ts', 'setTimeout(() => f(a, b), 100);'), []);
  assert.deepEqual(findSleeps('x.test.ts', 'setTimeout(fn);').map((v) => v.kind), ['non-literal']);
});

test('.tsx and .jsx test files are scanned', () => {
  mkdirSync(path.join(base, 'ui/test'), { recursive: true });
  writeFileSync(path.join(base, 'ui/test/view.test.tsx'), 'await sleep(5000);\n');
  writeFileSync(path.join(base, 'ui/test/view2.test.jsx'), 'await sleep(5000);\n');
  assert.deepEqual(check(base, ['ui'], []).map((v) => path.basename(v.file)).sort(), ['view.test.tsx', 'view2.test.jsx']);
  assert.deepEqual(findSleeps('x.test.tsx', 'const a = <div onClick={() => setTimeout(go, 5000)} />;').map((v) => v.ms), [5000]);
});

test('an allow-list entry for a missing file, or one that no longer matches a sleep, is a stale entry', () => {
  const file = 'pkg/test/sleep-300.test.ts';
  const ok = { file, line: 'await sleep(300);', reason: 'r' };
  assert.deepEqual(staleEntries(base, ['pkg'], [ok]), []);
  assert.equal(staleEntries(base, ['pkg'], [ok, { file: 'pkg/test/gone.test.ts', line: 'await sleep(300);', reason: 'r' }]).length, 1);
  assert.equal(staleEntries(base, ['pkg'], [ok, { file, line: 'await sleep(301);', reason: 'r' }]).length, 1);
  assert.equal(staleEntries(base, ['pkg'], [{ file: 'pkg/test/ok.test.ts', line: 'await sleep(250);', reason: 'r' }]).length, 1);
});

test('an allow-list entry covers the whole call: a wrapped call is exempt only with the delay it was approved with, and a changed delay makes the entry stale', () => {
  const wrapped = (ms) => `await new Promise((resolve) => setTimeout(\n  resolve,\n  ${ms},\n));\n`;
  const first = findSleeps('w.test.ts', wrapped(5000));
  assert.equal(first.length, 1);
  assert.match(first[0].text, /5000/, 'the text of the violation holds the delay, not only the line the call starts on');
  const entry = (line) => ({ file: 'w.test.ts', line, reason: 'a wait the product itself defines' });
  // An entry that names only the first line does not exempt the call.
  assert.equal(applyAllow(first, [entry('await new Promise((resolve) => setTimeout(')]).length, 1);
  // An entry that names the whole call does, with its delay.
  const whole = first[0].text;
  assert.equal(applyAllow(first, [entry(whole)]).length, 0);
  // Raising the delay: no longer exempt, and the entry is reported stale.
  const raised = findSleeps('w.test.ts', wrapped(50000));
  assert.equal(applyAllow(raised, [entry(whole)]).length, 1);
  // On disk: the entry that matched the 5,000 ms call is stale once the file holds 50,000 ms.
  fixture('wrapped.test.ts', wrapped(5000));
  const onDisk = { file: 'pkg/test/wrapped.test.ts', line: whole, reason: 'r' };
  assert.deepEqual(run([onDisk]).filter((v) => v.startsWith('wrapped')), []);
  assert.deepEqual(staleEntries(base, ['pkg'], [onDisk]), []);
  fixture('wrapped.test.ts', wrapped(50000));
  assert.equal(staleEntries(base, ['pkg'], [onDisk]).length, 1);
  assert.deepEqual(run([onDisk]).filter((v) => v.startsWith('wrapped')), ['wrapped.test.ts:50000']);
});
