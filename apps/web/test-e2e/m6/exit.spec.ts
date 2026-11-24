import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot } from '../support/env';
import { fileDisagreements, reportProblems, rowsOf } from './exit-proof';
import { FIREFOX_LEAVES_OUT, NOT_IN_FIREFOX } from './firefox-rule';
import { handshakeProblem } from './handshake-check';
import { headerArgs } from './headers';
import { SCENARIOS, listProblems, runLines, scenarioIdsOfReport, specFiles } from './scenarios';

// The list of the scenarios of the exit test and the report that says what proves each behaviour, checked as a script would: no stack is needed. The list is what `make test-m6` runs
// and prints; the report is `docs/proof/m6-exit.md`.
const report = readFileSync(path.join(repoRoot, 'docs/proof/m6-exit.md'), 'utf8');

test('the list of scenarios and the report agree: the same ids, the same files, every file there', () => {
  expect(listProblems(SCENARIOS, report)).toEqual([]);
  expect(fileDisagreements(SCENARIOS, report)).toEqual([]);
  expect(scenarioIdsOfReport(report)).toEqual(SCENARIOS.map((s) => s.id));
});

test('the report is sound: every proved row names files that are there, every pending row names its task and still lacks a file', () => {
  expect(reportProblems(report)).toEqual([]);
  const pending = rowsOf(report).filter((r) => r.state.startsWith('pending'));
  expect(pending.length, 'the screens that are not built are listed, not left out').toBeGreaterThan(5);
  for (const task of ['M6-T09', 'M6-T12a'])
    expect(
      pending.some((r) => r.state === `pending ${task}`),
      `${task} is listed as pending`,
    ).toBe(true);
  for (const id of ['search-palette', 'import']) expect(SCENARIOS.find((s) => s.id === id)?.pending, `${id} is a pending scenario`).toBeDefined();
});

test('the run names the three browsers and every scenario, and runs the files of the scenarios that are not pending once each', () => {
  const lines = runLines(SCENARIOS);
  expect(lines[0]).toBe('browsers: chromium, firefox, webkit');
  for (const s of SCENARIOS)
    expect(
      lines.some((l) => l.startsWith(`scenario ${s.id}:`)),
      `the run names ${s.id}`,
    ).toBe(true);
  expect(lines.filter((l) => l.includes('pending')).length).toBe(SCENARIOS.filter((s) => s.pending !== undefined).length);
  const files = specFiles(SCENARIOS);
  expect(new Set(files).size, 'once each').toBe(files.length);
  expect(files).toContain('apps/web/test-e2e/m6/handshake.spec.ts');
  expect(
    files.some((f) => f.includes('/search/') || f.includes('/import/')),
    'nothing of the pending screens is run',
  ).toBe(false);
});

test('removing a scenario from the list, or from the report, or naming a file that is not there, is found', () => {
  expect(
    listProblems(
      SCENARIOS.filter((s) => s.id !== 'offline'),
      report,
    ),
  ).toContain('the scenario "offline" is in docs/proof/m6-exit.md and not in the list');
  expect(listProblems(SCENARIOS, report.replace(/^\| `offline` .*\n/m, ''))).toContain('the scenario "offline" is in the list and not in docs/proof/m6-exit.md');
  expect(listProblems([...SCENARIOS, SCENARIOS[0]!], report)).toContain('the scenario "co-edit" is in the list twice');
  expect(
    listProblems(
      SCENARIOS.map((s) => (s.id === 'offline' ? { ...s, specs: ['apps/web/test-e2e/editor/nope.spec.ts'] } : s)),
      report,
    ).some((p) => p.includes('nope.spec.ts')),
  ).toBe(true);
  expect(
    listProblems(
      SCENARIOS.map((s) => (s.id === 'import' ? { id: s.id, title: s.title, specs: s.specs } : s)),
      report,
    ),
  ).toContain('the scenario "import" has no specification and is not marked pending');
  expect(
    listProblems(
      SCENARIOS.map((s) => (s.id === 'import' ? { ...s, pending: 'later' } : s)),
      report,
    ),
  ).toContain('the scenario "import" is pending on "later", which is not a task id');
});

test('a report with a proved row of a missing file, a pending row of files that are there, or a row with no state is found', () => {
  const row = (state: string, file = 'apps/web/test-e2e/m6/exit.spec.ts') => `| Shell (M6-T99) | A behaviour. | \`${file}\` | ${state} |`;
  const doc = (...rows: string[]) =>
    `## The scenarios\n\n| Scenario | What | Specifications | State |\n|---|---|---|---|\n| \`one\` | x | \`${'apps/web/test-e2e/m6/exit.spec.ts'}\` | proved |\n\n## What proves each behaviour\n\n| Area | Behaviour | Proof | State |\n|---|---|---|---|\n${Array.from({ length: 20 }, () => row('proved')).join('\n')}\n${rows.join('\n')}\n`;
  expect(reportProblems(doc())).toEqual([]);
  expect(reportProblems(doc(row('proved', 'apps/web/test-e2e/m6/missing.spec.ts')))).toEqual(['behaviour "A behaviour." is proved by apps/web/test-e2e/m6/missing.spec.ts, which is not there']);
  expect(reportProblems(doc(row('pending M6-T99')))).toEqual(['behaviour "A behaviour." is pending on M6-T99 but its files are all there: it is proved']);
  expect(reportProblems(doc(row('pending M6-T99', 'apps/web/test-e2e/m6/missing.spec.ts')))).toEqual([]);
  expect(reportProblems(doc(row('pending soon', 'apps/web/test-e2e/m6/missing.spec.ts')))).toEqual(['behaviour "A behaviour." is pending on "soon", which is not a task id']);
  expect(reportProblems(doc(row('')))[0]).toMatch(/has the state ""/);
  expect(reportProblems(doc(row('done')))[0]).toMatch(/has the state "done"/);
  expect(reportProblems('# nothing')).toContain('the report has no table of scenarios');
});

test('the check of the list, run as make runs it, prints the browsers and the scenarios and exits 0; with a scenario gone from the report it exits 1 and says which', () => {
  const run = (env: Record<string, string> = {}) => spawnSync('bun', ['run', 'apps/web/test-e2e/m6/scenarios.ts', 'check'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env } });
  const ok = run();
  expect(ok.status, ok.stderr).toBe(0);
  expect(ok.stdout).toContain('browsers: chromium, firefox, webkit');
  for (const s of SCENARIOS) expect(ok.stdout).toContain(`scenario ${s.id}:`);
  expect(ok.stdout).toContain('scenario search-palette: pending M6-T09');
  const dir = mkdtempSync(path.join(repoRoot, 'test-results', 'm6-exit-'));
  try {
    const shortened = path.join(dir, 'report.md');
    writeFileSync(shortened, report.replace(/^\| `offline` .*\n/m, ''));
    const bad = run({ M6_EXIT_REPORT: shortened });
    expect(bad.status, 'a scenario that is in the list and not in the report stops the run').toBe(1);
    expect(bad.stderr).toContain('the scenario "offline" is in the list and not in docs/proof/m6-exit.md');
    expect(bad.stderr).toContain('the list of scenarios is not sound');
    expect(bad.stdout, 'nothing is started').toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run of the exit test whose server does not require the handshake is refused with a plain line; the other runs are not asked', () => {
  expect(handshakeProblem({ M6_EXIT: '1' })).toBe('M6_REQUIRE_HANDSHAKE=1 is not set: the exit test runs against a server that requires the handshake (make test-m6 sets it)');
  expect(handshakeProblem({ M6_EXIT: '1', M6_REQUIRE_HANDSHAKE: '0' })).not.toBeNull();
  expect(handshakeProblem({ M6_EXIT: '1', M6_REQUIRE_HANDSHAKE: '1' })).toBeNull();
  expect(handshakeProblem({})).toBeNull();
  expect(handshakeProblem({ M6_REQUIRE_HANDSHAKE: '1' })).toBeNull();
});

test('the headers are rendered for the origins the stack names: the API as asked, the collaboration server and the store as the configuration says', () => {
  const args = headerArgs('http://127.0.0.1:8080/', { collabUrl: 'ws://127.0.0.1:8081/collab', fileStoreOrigin: 'http://127.0.0.1:8333' }, '/out');
  expect(args).toEqual(['scripts/render-headers.mjs', '--api-origin', 'http://127.0.0.1:8080', '--collab-origin', 'ws://127.0.0.1:8081', '--store-origin', 'http://127.0.0.1:8333', '--out', '/out']);
  expect(headerArgs('http://127.0.0.1:8080', { collabUrl: 'ws://127.0.0.1:8081/collab', fileStoreOrigin: null }, '/out')).toContain('http://127.0.0.1:8333');
});

test('the check of the list also checks the report: a proved row of a file that is not there stops the run, with the row', () => {
  const dir = mkdtempSync(path.join(repoRoot, 'test-results', 'm6-exit-'));
  try {
    const broken = path.join(dir, 'report.md');
    writeFileSync(broken, report.replace('`apps/web/test-e2e/m6/exit.spec.ts` | proved', '`apps/web/test-e2e/m6/missing.spec.ts` | proved'));
    const run = spawnSync('bun', ['run', 'apps/web/test-e2e/m6/scenarios.ts', 'check'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, M6_EXIT_REPORT: broken } });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('missing.spec.ts, which is not there');
    expect(run.stdout).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the report and the run say where Firefox does not run a proof: the rule is the config's, the run line says so, and a row that rests only on files Firefox leaves out must say so", () => {
  const config = readFileSync(path.join(repoRoot, 'apps/web/playwright.config.ts'), 'utf8');
  expect(config, 'the rule of this folder is the one of the Firefox project').toContain(`FIREFOX_ARIA_CRASH_SPECS = [${FIREFOX_LEAVES_OUT.map(String).join(', ')}]`);
  const lines = runLines(SCENARIOS);
  expect(lines.find((l) => l.startsWith('scenario axe:'))).toContain('NOT run in firefox');
  expect(lines.find((l) => l.startsWith('scenario co-edit:')) ?? '').not.toContain('NOT run in firefox');
  const rows = rowsOf(report).filter((r) => r.files.length > 0 && r.files.every((f) => FIREFOX_LEAVES_OUT.some((re) => re.test(`/${f}`))));
  expect(rows.length, 'there are such rows').toBeGreaterThan(5);
  for (const row of rows) expect(row.text, row.label).toContain(NOT_IN_FIREFOX);
  const unmarked = report.replaceAll(` (${NOT_IN_FIREFOX}: Chromium and WebKit only)`, '');
  const problems = reportProblems(unmarked);
  expect(
    problems.some((p) => p.includes('does not say so')),
    'a report that does not say it is refused',
  ).toBe(true);
  expect(reportProblems(report)).toEqual([]);
});
