import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFloorMatches } from '../check-floor-matches.mjs';

const root = '/work/repo';
const entry = { total: 1, covered: 1, skipped: 0, pct: 100 };
const file = (name) => [`${root}/${name}`, { statements: entry, branches: entry, functions: entry, lines: entry }];
const summary = (...names) => Object.fromEntries([['total', { statements: entry }], ...names.map(file)]);
const floors = { autoUpdate: false, statements: 80, branches: 70, 'packages/core/src/**': { statements: 98 }, 'apps/server/src/cli.ts': { lines: 50 } };

test('passes when every file is under the workspace and every glob of a floor matches a file', () => {
  const result = checkFloorMatches({ summary: summary('packages/core/src/a.ts', 'apps/server/src/cli.ts'), thresholds: floors, root });
  assert.deepEqual(result, { outside: [], unmatched: [] });
});

test('names a glob or a file floor that matches nothing, and ignores the plain thresholds and autoUpdate', () => {
  const result = checkFloorMatches({ summary: summary('packages/core/src/a.ts'), thresholds: floors, root });
  assert.deepEqual(result.unmatched, ['apps/server/src/cli.ts']);
  assert.deepEqual(result.outside, []);
});

test('names files whose paths are not under the workspace, the signature of a report made at another path', () => {
  const elsewhere = Object.fromEntries([['/home/runner/_work/r/r/packages/core/src/a.ts', { statements: entry }], ...[file('apps/server/src/cli.ts')]]);
  const result = checkFloorMatches({ summary: elsewhere, thresholds: floors, root });
  assert.deepEqual(result.outside, ['/home/runner/_work/r/r/packages/core/src/a.ts']);
  assert.deepEqual(result.unmatched, ['packages/core/src/**']);
});

test('an empty report has nothing outside and every floor unmatched', () => {
  assert.deepEqual(checkFloorMatches({ summary: summary(), thresholds: floors, root }), { outside: [], unmatched: ['packages/core/src/**', 'apps/server/src/cli.ts'] });
});
