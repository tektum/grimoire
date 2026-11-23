// Coverage blobs carry the absolute file paths of the workspace that made them. The Coverage job merges blobs made on other runners, so each
// blob job records its workspace in `<name>.root` in a directory of its own (vitest reads every file of the blob directory as a blob), and this
// rewrites that prefix to the current workspace before merging
// (otherwise a floor's glob would match no file and pass without checking anything). A blob without its root file is an error, not a guess.
//   node tools/ci/rebase-blobs.mjs vitest-blobs vitest-blob-roots
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Rewrites every `<root>/` in each `*.json` blob of `dir` to `<workspace>/`, the root being in `<rootsDir>/<name>.root`; returns the blobs done and those without one. */
export function rebaseBlobs(dir, rootsDir, workspace) {
  const rebased = [];
  const missing = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    let root;
    try {
      root = readFileSync(path.join(rootsDir, name.replace(/\.json$/, '.root')), 'utf8').trim().replace(/\/+$/, '');
    } catch {
      missing.push(name);
      continue;
    }
    const file = path.join(dir, name);
    writeFileSync(file, readFileSync(file, 'utf8').split(`${root}/`).join(`${workspace}/`));
    rebased.push(name);
  }
  return { rebased, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, rootsDir] = process.argv.slice(2);
  if (dir === undefined || rootsDir === undefined) {
    process.stderr.write('usage: node tools/ci/rebase-blobs.mjs <blob directory> <root directory>\n');
    process.exit(2);
  }
  const workspace = path.resolve(import.meta.dirname, '../..');
  const { rebased, missing } = rebaseBlobs(dir, rootsDir, workspace);
  for (const name of missing) process.stderr.write(`::error::${name} has no matching .root file: the workspace it was made in is unknown\n`);
  if (rebased.length === 0 || missing.length > 0) {
    if (rebased.length === 0 && missing.length === 0) process.stderr.write('::error::no coverage blobs found in ' + dir + '\n');
    process.exit(1);
  }
  process.stdout.write(`rebased ${rebased.join(', ')} to ${workspace}\n`);
}
