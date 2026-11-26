import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// M7-T07: the test list of `make test-m7`. The script of the list names the groups the exit test is made of, checks that the list has every one of them and that every file it names exists,
// and runs them one after another; removing a group (or a file) from the list makes the target exit 1.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = path.join(root, 'apps/server/test/m7/groups.mjs');
const GROUPS = path.join(root, 'apps/server/test/m7/groups.json');
const REQUIRED = ['search', 'jobs', 'hostile', 'synthetic', 'remote-images', 'restart', 'semantic', 'security'];

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'm7-list-'));
  scratch.push(d);
  return d;
};
type Groups = Record<string, { files?: string[]; pending?: string[]; projects?: string[] }>;
const real = (): Groups => JSON.parse(readFileSync(GROUPS, 'utf8')) as Groups;
const withList = (groups: Groups): string => {
  const file = path.join(tmp(), 'groups.json');
  writeFileSync(file, JSON.stringify(groups));
  return file;
};
const node = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });

describe('the test list of the M7 exit test', () => {
  it('names the search, jobs, hostile, synthetic, remote-image, restart, semantic and security groups, and its check passes', () => {
    expect(Object.keys(real()).sort()).toEqual([...REQUIRED].sort());
    const r = node(['check']);
    expect(r.status, r.stderr).toBe(0);
  });

  it.each(REQUIRED)('exits 1, naming it, when the group %s is taken out of the list', (name) => {
    const groups = real();
    delete groups[name];
    const r = node(['check'], { M7_GROUPS_FILE: withList(groups) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`group "${name}" is not in the list`);
  });

  it('exits 1 for a file that is named and does not exist, a pending file that exists now, a group with nothing in it and a group that is not one of the exit test', () => {
    const groups = real();
    groups['jobs']!.files = [...groups['jobs']!.files!, 'apps/server/test/jobs/no-such-file.test.ts'];
    groups['search']!.pending = ['apps/server/test/m7/target-list.test.ts'];
    groups['hostile'] = {};
    groups['mystery'] = { files: ['apps/server/test/m7/target-list.test.ts'] };
    const r = node(['check'], { M7_GROUPS_FILE: withList(groups) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('jobs: apps/server/test/jobs/no-such-file.test.ts does not exist');
    expect(r.stderr).toContain('search: apps/server/test/m7/target-list.test.ts exists now: move it to "files"');
    expect(r.stderr).toContain('hostile: nothing to run');
    expect(r.stderr).toContain('group "mystery" is not a group of the exit test');
  });

  it('fails the run for a group with a test that is not written yet, though every group that has files passes, unless M7_ALLOW_PENDING=1 is set', () => {
    const dir = tmp();
    const runner = path.join(dir, 'runner.mjs');
    writeFileSync(runner, 'process.exit(0);\n');
    const groups = real();
    groups['restart'] = { pending: ['apps/server/test/m7/not-written-yet.container.test.ts'], projects: ['container'] };
    const env = { M7_GROUPS_FILE: withList(groups), M7_RUNNER: runner, M7_ALLOW_PENDING: '0' }; // off, whatever the caller's shell has
    const refused = node(['run'], env);
    expect(refused.status, 'a test that is not written must not read as a pass').toBe(1);
    expect(refused.stdout).toContain('PENDING restart: apps/server/test/m7/not-written-yet.container.test.ts');
    expect(refused.stdout).toMatch(/FAIL restart: .*not-written-yet.*M7_ALLOW_PENDING=1/);
    const allowed = node(['run'], { ...env, M7_ALLOW_PENDING: '1' });
    expect(allowed.status, allowed.stdout).toBe(0);
    expect(allowed.stdout).toContain('PENDING restart: apps/server/test/m7/not-written-yet.container.test.ts');
  });

  it('runs every group in order, one runner call each with its projects and files, goes on after a group that fails, says PENDING for what is not written, and exits 1 for the failure', () => {
    const dir = tmp();
    const log = path.join(dir, 'calls.log');
    const runner = path.join(dir, 'runner.mjs');
    writeFileSync(
      runner,
      `import { appendFileSync } from 'node:fs'; const a = process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n'); process.exit(a.some((x) => x.includes('/jobs')) ? 3 : 0);\n`,
    );
    const groups = real();
    groups['restart'] = { pending: ['apps/server/test/m7/not-written-yet.container.test.ts'], projects: ['container'] };
    const r = node(['run'], { M7_GROUPS_FILE: withList(groups), M7_RUNNER: runner });
    expect(r.status).toBe(1);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(REQUIRED.length - 1); // restart has no file yet: it is pending, not run
    expect(calls[0]).toMatch(/^--project unit --project integration apps\/server\/test\/search /);
    expect(r.stdout).toMatch(/PASS search/);
    expect(r.stdout).toMatch(/FAIL jobs \(exit 3\)/);
    expect(r.stdout).toMatch(/PASS hostile/); // after the failure
    expect(r.stdout).toContain('PENDING restart: apps/server/test/m7/not-written-yet.container.test.ts');
  });

  it('runs a group with the projects it names (a container test is run by the container project only)', () => {
    const dir = tmp();
    const log = path.join(dir, 'calls.log');
    const runner = path.join(dir, 'runner.mjs');
    writeFileSync(runner, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`);
    const groups = real();
    groups['restart'] = { files: ['apps/server/test/m7/target-list.test.ts'], projects: ['container'] };
    const r = node(['run'], { M7_GROUPS_FILE: withList(groups), M7_RUNNER: runner });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('--project container apps/server/test/m7/target-list.test.ts');
  });

  it('exits 1 when two groups name the same file, or a folder and a file in it (a file would run twice and a failure would be reported under both)', () => {
    const groups = real();
    groups['remote-images']!.files = [...groups['remote-images']!.files!, 'apps/server/test/import/engine/remote-hook.test.ts'];
    const r = node(['check'], { M7_GROUPS_FILE: withList(groups) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps/server/test/import/engine/remote-hook.test.ts is in "remote-images" and in "synthetic"');
  });

  it('runs the semantic group in the container project too (the real-model tests are *.container.test.ts and the other projects leave them out)', () => {
    expect(real()['semantic']!.projects).toEqual(expect.arrayContaining(['unit', 'integration', 'container']));
  });

  it('refuses a runner from the environment unless the list is a test list too, so that a stray M7_RUNNER cannot make the target pass without running the tests', () => {
    const r = node(['run'], { M7_RUNNER: process.execPath });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('M7_RUNNER is only for the test of this script');
  });
});
