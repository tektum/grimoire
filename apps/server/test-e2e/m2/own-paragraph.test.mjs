// Fails when a scenario file lets clients type through any path but `typeInOwnParagraph` (or `editSettled`, which the scenario calls only while all
// clients agree). Reason: y-prosemirror interleaves letters typed at the same spot by two unsynced clients (docs/proof/m2-live-save.md).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const dir = new URL('./scenarios/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
const FORBIDDEN = [/\.typeOwn\(/, /\.act\(/, /\.step\(/, /\.insertText\(/, /\.dispatch\(/, /\.text\.insert\(/, /getText\(/];

test('there are scenario files', () => { assert.ok(files.length >= 5); });
for (const f of files) {
  const src = readFileSync(new URL(f, dir), 'utf8');
  test(`${f} types only through typeInOwnParagraph`, () => {
    for (const re of FORBIDDEN) assert.doesNotMatch(src, re, `${f} types through ${String(re)}`);
  });
  test(`${f} calls editSettled only after waiting for all clients to agree`, () => {
    for (const m of src.matchAll(/\.editSettled\(/g)) {
      const before = src.slice(Math.max(0, m.index - 200), m.index);
      assert.match(before, /settle\(\)/, `${f}: editSettled without a settle() before it`);
    }
  });
}
test('the typing scenarios use the helper', () => {
  for (const f of ['markdown-equals-live.ts', 'restart-mid-edit.ts', 'hostile-neighbour.ts']) {
    assert.match(readFileSync(new URL(f, dir), 'utf8'), /typeInOwnParagraph\(/, `${f} does not use typeInOwnParagraph`);
  }
});
