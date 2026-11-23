// Fails when the proof note loses its stale-tab section or one of the names the section must carry.
// Plain `node --test`: run by `make test-m2` before the scenarios (the vitest projects look only at test/ and src/ folders).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const note = readFileSync(new URL('../../../../docs/proof/m2-live-save.md', import.meta.url), 'utf8');
const HEADING = '## Known limit: the epoch does not stop stale tabs';

function section() {
  const start = note.indexOf(`\n${HEADING}\n`);
  assert.notEqual(start, -1, `docs/proof/m2-live-save.md has no section "${HEADING}"`);
  const body = note.slice(start + HEADING.length + 2);
  const next = body.search(/^## /m);
  return next === -1 ? body : body.slice(0, next);
}

test('the stale-tab section exists', () => { section(); });
for (const name of ['1000', '4409']) {
  test(`the stale-tab section names ${name}`, () => { assert.ok(section().includes(name), `the section does not mention ${name}`); });
}
test('the section says the pre-change edits are merged back and saved', () => {
  const s = section();
  assert.match(s, /merge/);
  assert.match(s, /saved/);
});
test('the section says what the limit is and that the fix is planned, not built', () => {
  const s = section();
  assert.match(s, /stale tab/);
  assert.match(s, /epoch/);
  assert.match(s, /planned/);
});
for (const key of ['state-bytes', 'markdown-bytes', 'bytes-per-markdown-kb', 'seed-ms', 'save-ms', 'max-ping-ms']) {
  test(`the note has a ${key}: line`, () => { assert.match(note, new RegExp(`^${key}: .+$`, 'm')); });
}
test('max-ping-ms is below 100', () => {
  const m = /^max-ping-ms: ([0-9.]+)/m.exec(note);
  assert.ok(m, 'no max-ping-ms value');
  assert.ok(Number(m[1]) < 100);
});
