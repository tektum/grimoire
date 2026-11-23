// Prints the coverage of a `json-summary` report per package as a Markdown table (for the CI job summary).
//   node tools/ci/coverage-summary.mjs coverage/merged/coverage-summary.json >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const METRICS = ['statements', 'branches', 'functions', 'lines'];

/** `apps/server`, `packages/core`, `packages/adapters/files-s3`: the package a repository-relative file belongs to. */
export function packageOf(file) {
  const parts = file.split('/');
  if (parts[0] === 'packages' && parts[1] === 'adapters') return parts.slice(0, 3).join('/');
  if (parts[0] === 'apps' || parts[0] === 'packages') return parts.slice(0, 2).join('/');
  return parts[0];
}

/** One row per package: the number of files and, per metric, covered over total (never an average of percentages). */
export function summarise(summary, root) {
  const sums = new Map();
  for (const [file, entry] of Object.entries(summary)) {
    if (file === 'total') continue;
    const relative = path.relative(root, file);
    if (relative.startsWith('..')) continue;
    const name = packageOf(relative.split(path.sep).join('/'));
    const row = sums.get(name) ?? { name, files: 0, ...Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }])) };
    row.files += 1;
    for (const metric of METRICS) {
      row[metric].covered += entry[metric].covered;
      row[metric].total += entry[metric].total;
    }
    sums.set(name, row);
  }
  const pct = ({ covered, total }) => (total === 0 ? 100 : (covered / total) * 100);
  return [...sums.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => ({ name: row.name, files: row.files, ...Object.fromEntries(METRICS.map((m) => [m, pct(row[m])])), _sums: Object.fromEntries(METRICS.map((m) => [m, row[m]])) }));
}

/** The table, with a line for everything together. */
export function toMarkdown(rows) {
  const cell = (n) => n.toFixed(1);
  const line = (name, files, values) => `| ${name} | ${String(files)} | ${METRICS.map((m) => cell(values[m])).join(' | ')} |`;
  const all = Object.fromEntries(METRICS.map((m) => {
    const sum = rows.reduce((acc, row) => ({ covered: acc.covered + row._sums[m].covered, total: acc.total + row._sums[m].total }), { covered: 0, total: 0 });
    return [m, sum.total === 0 ? 100 : (sum.covered / sum.total) * 100];
  }));
  return [
    '| Package | Files | Statements | Branches | Functions | Lines |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) => line(row.name, row.files, row)),
    line('**All**', rows.reduce((n, row) => n + row.files, 0), all),
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file] = process.argv.slice(2);
  if (file === undefined) {
    process.stderr.write('usage: node tools/ci/coverage-summary.mjs <coverage-summary.json>\n');
    process.exit(2);
  }
  const root = path.resolve(import.meta.dirname, '../..');
  process.stdout.write(`### Coverage per package\n\n${toMarkdown(summarise(JSON.parse(readFileSync(file, 'utf8')), root))}`);
}
