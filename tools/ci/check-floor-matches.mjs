// Guards the merged coverage floors against passing for the wrong reason. Coverage blobs carry absolute file paths from the machine that made
// them; if the unit, integration and merging jobs ran under different workspace paths, a floor's glob would match no file and be satisfied by nothing.
// The check fails when a file of the merged report is not under this workspace, or when a floor names a glob (or file) that matches no file.
//   node tools/ci/check-floor-matches.mjs coverage/merged/coverage-summary.json
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The files outside the root and the floor globs that match no file of the report. */
export function checkFloorMatches({ summary, thresholds, root }) {
  const files = Object.keys(summary).filter((key) => key !== 'total');
  const outside = files.filter((file) => path.relative(root, file).startsWith('..'));
  const relative = files.filter((file) => !outside.includes(file)).map((file) => path.relative(root, file).split(path.sep).join('/'));
  const globs = Object.entries(thresholds).filter(([, value]) => typeof value === 'object' && value !== null).map(([glob]) => glob);
  const unmatched = globs.filter((glob) => !relative.some((file) => path.posix.matchesGlob(file, glob)));
  return { outside, unmatched };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file] = process.argv.slice(2);
  if (file === undefined) {
    process.stderr.write('usage: node tools/ci/check-floor-matches.mjs <coverage-summary.json>\n');
    process.exit(2);
  }
  const root = path.resolve(import.meta.dirname, '../..');
  const { default: merged } = await import('../../vitest.merged-coverage.config.js');
  const { outside, unmatched } = checkFloorMatches({ summary: JSON.parse(readFileSync(file, 'utf8')), thresholds: merged.test.coverage.thresholds, root });
  for (const f of outside.slice(0, 5)) process.stderr.write(`::error::coverage report file is not under the workspace (${root}): ${f}\n`);
  if (outside.length > 5) process.stderr.write(`::error::... and ${String(outside.length - 5)} more outside the workspace\n`);
  for (const glob of unmatched) process.stderr.write(`::error::the floor for "${glob}" matches no file of the merged report\n`);
  if (outside.length > 0 || unmatched.length > 0) process.exit(1);
  process.stdout.write('every coverage floor matches files of the merged report, all under the workspace\n');
}
