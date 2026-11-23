import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageOf, summarise, toMarkdown } from '../coverage-summary.mjs';

const root = '/work/repo';
const entry = (covered, total) => ({ total, covered, skipped: 0, pct: total === 0 ? 100 : (covered / total) * 100 });
const file = (name, [s, st], [b, bt], [f, ft], [l, lt]) => [`${root}/${name}`, { statements: entry(s, st), branches: entry(b, bt), functions: entry(f, ft), lines: entry(l, lt) }];

test('a file belongs to its app or package, and an adapter to its own package under packages/adapters', () => {
  assert.equal(packageOf('apps/server/src/cli.ts'), 'apps/server');
  assert.equal(packageOf('packages/core/src/ports/clock.ts'), 'packages/core');
  assert.equal(packageOf('packages/adapters/files-s3/src/setup.ts'), 'packages/adapters/files-s3');
  assert.equal(packageOf('tools/other.ts'), 'tools');
});

test('the totals of a package are the sums of its files, not an average of percentages', () => {
  const summary = Object.fromEntries([
    file('packages/core/src/a.ts', [9, 10], [1, 2], [1, 1], [9, 10]),
    file('packages/core/src/b.ts', [1, 90], [0, 0], [0, 9], [1, 90]),
    file('packages/adapters/files-s3/src/c.ts', [10, 10], [4, 4], [2, 2], [10, 10]),
    ['total', { statements: entry(20, 110) }],
  ]);
  const rows = summarise(summary, root);
  assert.deepEqual(rows.map((r) => r.name), ['packages/adapters/files-s3', 'packages/core']);
  const core = rows.find((r) => r.name === 'packages/core');
  assert.equal(core.files, 2);
  assert.equal(core.statements, 10);
  assert.equal(core.branches, 50);
  assert.equal(core.functions, 10);
  assert.equal(core.lines, 10);
  assert.equal(rows.find((r) => r.name === 'packages/adapters/files-s3').statements, 100);
});

test('a package with nothing to cover in a metric shows 100, and the table has a total line', () => {
  const summary = Object.fromEntries([file('apps/server/src/a.ts', [5, 10], [0, 0], [1, 2], [5, 10])]);
  const rows = summarise(summary, root);
  assert.equal(rows[0].branches, 100);
  const text = toMarkdown(rows);
  assert.match(text, /^\| Package \| Files \| Statements \| Branches \| Functions \| Lines \|$/m);
  assert.match(text, /\| apps\/server \| 1 \| 50\.0 \| 100\.0 \| 50\.0 \| 50\.0 \|/);
  assert.match(text, /\| \*\*All\*\* \| 1 \| 50\.0 \| 100\.0 \| 50\.0 \| 50\.0 \|/);
});

test('files outside the repository root are ignored', () => {
  const summary = Object.fromEntries([['/elsewhere/x.ts', { statements: entry(1, 1), branches: entry(0, 0), functions: entry(1, 1), lines: entry(1, 1) }]]);
  assert.deepEqual(summarise(summary, root), []);
});
