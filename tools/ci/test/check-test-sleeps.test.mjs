import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyAllow, check, findSleeps } from '../check-test-sleeps.mjs';

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
