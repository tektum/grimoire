import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { rebaseBlobs } from '../rebase-blobs.mjs';

// Scratch directories live inside this folder (the system temp directory may be full) and are removed afterwards.
const base = mkdtempSync(path.join(import.meta.dirname, 'work-'));
test.after(() => { rmSync(base, { recursive: true, force: true }); });
const dir = (name) => { const d = path.join(base, name); mkdirSync(d); mkdirSync(`${d}-roots`); return d; };

test('rewrites the workspace prefix of each blob to this workspace, only at a path boundary', () => {
  const d = dir('rewrite');
  const text = JSON.stringify([{ file: '/runner/a/ws/apps/x.ts' }, { file: '/runner/a/ws-other/y.ts' }, { url: 'file:///runner/a/ws/packages/z.ts' }]);
  writeFileSync(path.join(d, 'unit.json'), text);
  writeFileSync(path.join(`${d}-roots`, 'unit.root'), '/runner/a/ws\n');
  const result = rebaseBlobs(d, `${d}-roots`, '/here/ws');
  assert.deepEqual(result, { rebased: ['unit.json'], missing: [] });
  assert.equal(readFileSync(path.join(d, 'unit.json'), 'utf8'), text.replace('/runner/a/ws/apps', '/here/ws/apps').replace('file:///runner/a/ws/packages', 'file:///here/ws/packages'));
});

test('a blob made at this workspace is left as it is', () => {
  const d = dir('same');
  writeFileSync(path.join(d, 'integration.json'), '["/here/ws/a.ts"]');
  writeFileSync(path.join(`${d}-roots`, 'integration.root'), '/here/ws');
  assert.deepEqual(rebaseBlobs(d, `${d}-roots`, '/here/ws'), { rebased: ['integration.json'], missing: [] });
  assert.equal(readFileSync(path.join(d, 'integration.json'), 'utf8'), '["/here/ws/a.ts"]');
});

test('a blob without its root file is named, not guessed at', () => {
  const d = dir('missing');
  writeFileSync(path.join(d, 'unit.json'), '[]');
  assert.deepEqual(rebaseBlobs(d, `${d}-roots`, '/here/ws'), { rebased: [], missing: ['unit.json'] });
});
