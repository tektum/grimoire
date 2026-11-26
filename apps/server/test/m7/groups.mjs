#!/usr/bin/env node
// The test list of the M7 exit test (`make test-m7`): the groups it is made of and the files of each, in groups.json.
//   node apps/server/test/m7/groups.mjs check   exits 1 unless the list has every group of the exit test and every file it names exists
//   node apps/server/test/m7/groups.mjs list    prints the list
//   node apps/server/test/m7/groups.mjs run     checks, then runs the groups one after another (vitest, with the projects of each group), goes on after a group that fails, and exits 1 if one did;
//                                               a `pending` file counts as a failure (a test that is not written must not read as a pass) unless M7_ALLOW_PENDING=1 is set, for the time a test is being written
// A group has `files` (files or folders, relative to the repository), the vitest `projects` they run in (default unit and integration), and `pending`: files that are not written yet, which the run
// says so about and which `check` refuses once they exist (they must move to `files`, or nothing runs them). M7_GROUPS_FILE names another list and M7_RUNNER another runner (a script given the
// arguments vitest would get): both are for the test of this script.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
/** The groups the exit test is made of (M7-T07, contracts section 10): removing one from the list must fail the target. */
export const REQUIRED = ['search', 'jobs', 'hostile', 'synthetic', 'remote-images', 'restart', 'semantic', 'security'];
const DEFAULT_PROJECTS = ['unit', 'integration'];

const load = () => JSON.parse(readFileSync(process.env['M7_GROUPS_FILE'] ?? path.join(here, 'groups.json'), 'utf8'));

export function problems(groups) {
  const out = [];
  for (const name of REQUIRED) if (!Object.hasOwn(groups, name)) out.push(`group "${name}" is not in the list`);
  for (const [name, group] of Object.entries(groups)) {
    if (!REQUIRED.includes(name)) out.push(`group "${name}" is not a group of the exit test`);
    const files = group.files ?? [];
    const pending = group.pending ?? [];
    if (files.length === 0 && pending.length === 0) out.push(`${name}: nothing to run`);
    for (const f of files) if (!existsSync(path.join(root, f))) out.push(`${name}: ${f} does not exist`);
    for (const f of pending) if (existsSync(path.join(root, f))) out.push(`${name}: ${f} exists now: move it to "files"`);
  }
  // A file that two groups both reach (the same entry, or a folder and a file in it) runs twice and a failure is reported under both.
  const entries = Object.entries(groups).flatMap(([name, group]) => (group.files ?? []).map((f) => [name, f.replace(/\/+$/, '')]));
  for (const [i, [a, fa]] of entries.entries())
    for (const [b, fb] of entries.slice(i + 1))
      if (a !== b && (fa === fb || fa.startsWith(`${fb}/`) || fb.startsWith(`${fa}/`))) out.push(`${fa.length >= fb.length ? fa : fb} is in "${fa.length >= fb.length ? a : b}" and in "${fa.length >= fb.length ? b : a}"`);
  return out;
}

function check() {
  const found = problems(load());
  for (const p of found) console.error(p);
  return found.length === 0;
}

function run() {
  if (!check()) return false;
  if (process.env['M7_RUNNER'] !== undefined && process.env['M7_GROUPS_FILE'] === undefined) {
    console.error('M7_RUNNER is only for the test of this script (with M7_GROUPS_FILE): it would replace vitest for every group');
    process.exit(2);
  }
  const groups = load();
  let failed = 0;
  const allowPending = process.env['M7_ALLOW_PENDING'] === '1';
  for (const name of REQUIRED) {
    const group = groups[name];
    for (const f of group.pending ?? []) {
      console.log(`PENDING ${name}: ${f}`);
      if (!allowPending) {
        console.log(`FAIL ${name}: ${f} is not written yet (M7_ALLOW_PENDING=1 allows it while it is being written)`);
        failed += 1;
      }
    }
    if ((group.files ?? []).length === 0) continue;
    const projects = (group.projects ?? DEFAULT_PROJECTS).flatMap((p) => ['--project', p]);
    const runner = process.env['M7_RUNNER'];
    const [cmd, args] = runner === undefined ? ['bunx', ['vitest', 'run', ...projects, ...group.files]] : [process.execPath, [runner, ...projects, ...group.files]];
    console.log(`RUN ${name}`);
    const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
    const status = r.status ?? 1;
    console.log(status === 0 ? `PASS ${name}` : `FAIL ${name} (exit ${String(status)})`);
    if (status !== 0) failed += 1;
  }
  return failed === 0;
}

const command = process.argv[2];
if (command === 'check') process.exit(check() ? 0 : 1);
else if (command === 'run') process.exit(run() ? 0 : 1);
else if (command === 'list') {
  for (const [name, group] of Object.entries(load())) {
    for (const f of group.files ?? []) console.log(`${name}: ${f}`);
    for (const f of group.pending ?? []) console.log(`${name}: PENDING ${f}`);
  }
} else {
  console.error('usage: groups.mjs check | list | run');
  process.exit(2);
}
