import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BROWSERS } from '../support/browsers.ts';
import { firefoxLeavesOut } from './firefox-rule.ts';
import { repoRoot } from '../support/env.ts';
import { fileDisagreements, reportProblems } from './exit-proof.ts';

/**
 * The scenarios of the web client's exit test, each proved once in every browser by the specifications named here (all of them real-stack specifications except where the file
 * says otherwise). A scenario whose screen is not built yet is `pending` with the task that builds it: it is listed in the run and in the report, never left out, and it has no files
 * until that task adds them. `docs/proof/m6-exit.md` lists the same ids: the check below fails when the two differ.
 */
export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly specs: readonly string[];
  readonly pending?: string;
}

const E = 'apps/web/test-e2e';

export const SCENARIOS: readonly Scenario[] = [
  { id: 'co-edit', title: "two people sign in with development tokens, edit one paragraph and keep each other's text", specs: [`${E}/editor/co-edit.spec.ts`] },
  { id: 'cursors', title: 'remote cursors carry the names of the people', specs: [`${E}/editor/remote-cursors.spec.ts`] },
  { id: 'soft-lock', title: 'the soft lock refuses a change of structure and names the person who is in the block', specs: [`${E}/lock/lock.spec.ts`] },
  { id: 'offline', title: 'an edit made offline is kept and merged on reconnect', specs: [`${E}/editor/offline.spec.ts`] },
  {
    id: 'status-messages',
    title: 'every status message is shown for the signal that causes it: with the server stopped, and with the scripted server',
    specs: [`${E}/status/messages.spec.ts`, `${E}/editor/signal-rows.spec.ts`, `${E}/editor/connection-signals.spec.ts`],
  },
  { id: 'images', title: 'an image pasted into a page is uploaded, and an expired image address is refreshed', specs: [`${E}/attachments/upload-flow.spec.ts`, `${E}/attachments/url-refresh.spec.ts`] },
  { id: 'search-palette', title: 'search and the palette find a page and open it (against the scripted search until the stack has the endpoint)', specs: [`${E}/search/palette.spec.ts`] },
  { id: 'history-restore', title: 'a restored version is seen by the second browser', specs: [`${E}/history/restore.spec.ts`] },
  { id: 'admin', title: 'the admin screens change a role, a group and the access of a collection', specs: [`${E}/admin/admin.spec.ts`] },
  { id: 'import', title: 'the import screen takes a file into a collection', specs: [], pending: 'M6-T12a' },
  {
    id: 'xss',
    title: 'hostile content is shown as text or refused: links, images, raw HTML, names and titles',
    specs: [
      `${E}/editor/unsafe-links.spec.ts`,
      `${E}/history/safety.spec.ts`,
      `${E}/safety/raw-html.spec.ts`,
      `${E}/safety/paste.spec.ts`,
      `${E}/safety/corpus.spec.ts`,
      `${E}/safety/milkdown-guard.spec.ts`,
      `${E}/attachments/corpus-images.spec.ts`,
    ],
  },
  { id: 'axe', title: 'axe finds nothing serious on every route, in the light and the dark scheme', specs: [`${E}/a11y/tour.spec.ts`] },
  { id: 'origins', title: 'the web origin differs from the API origin in every request, and no request carries a cookie', specs: [`${E}/m6/origins.spec.ts`] },
  { id: 'handshake', title: 'the server requires the handshake: a bare token is refused', specs: [`${E}/m6/handshake.spec.ts`] },
  { id: 'mutation', title: 'a broken mapSignal row and a broken isSafeHref rule make the checks fail', specs: [`${E}/m6/mutation.spec.ts`] },
];

/** The ids a report lists: the first column of the rows of its table of scenarios. */
export function scenarioIdsOfReport(markdown: string): string[] {
  const section = markdown.split(/^## /m).find((part) => part.startsWith('The scenarios'));
  if (section === undefined) return [];
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => /^\| `([a-z0-9-]+)`/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

/** What is wrong with the list: a scenario the report has and the list lacks (or the other way), a scenario twice, a specification that is not there. Empty when it is sound. */
export function listProblems(scenarios: readonly Scenario[], report: string, exists: (file: string) => boolean = (file) => existsSync(path.join(repoRoot, file))): string[] {
  const problems: string[] = [];
  const ids = scenarios.map((s) => s.id);
  const inReport = scenarioIdsOfReport(report);
  for (const id of inReport) if (!ids.includes(id)) problems.push(`the scenario "${id}" is in docs/proof/m6-exit.md and not in the list`);
  for (const id of ids) if (!inReport.includes(id)) problems.push(`the scenario "${id}" is in the list and not in docs/proof/m6-exit.md`);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) problems.push(`the scenario "${id}" is in the list twice`);
  for (const s of scenarios) {
    if (s.pending !== undefined) {
      if (!/^M\d+-T\d+[a-z]?$/.test(s.pending)) problems.push(`the scenario "${s.id}" is pending on "${s.pending}", which is not a task id`);
      if (s.specs.length > 0) problems.push(`the scenario "${s.id}" is pending and has specifications: take the mark off`);
    } else if (s.specs.length === 0) problems.push(`the scenario "${s.id}" has no specification and is not marked pending`);
    for (const file of s.specs) if (!exists(file)) problems.push(`the scenario "${s.id}" names ${file}, which is not there`);
  }
  return problems;
}

/** The lines the run prints: the three browsers, then each scenario with the state it is in. */
export function runLines(scenarios: readonly Scenario[]): string[] {
  return [`browsers: ${BROWSERS.join(', ')}`, ...scenarios.map((s) => `scenario ${s.id}: ${s.pending === undefined ? `${s.specs.length} specification file(s)${firefoxNote(s.specs)}` : `pending ${s.pending}`}`)];
}

/** What the line of a scenario says about Firefox: nothing when it runs all the files, else that it leaves out all of them or how many (the Firefox project ignores them: see `firefox-rule.ts`). */
function firefoxNote(specs: readonly string[]): string {
  const out = specs.filter(firefoxLeavesOut).length;
  if (out === 0) return '';
  return out === specs.length ? '; NOT run in firefox (only chromium and webkit)' : `; ${String(out)} of them NOT run in firefox`;
}

/** The specification files to run, once each, in the order of the list: those of the scenarios that are not pending. */
export const specFiles = (scenarios: readonly Scenario[]): string[] => [...new Set(scenarios.flatMap((s) => (s.pending === undefined ? s.specs : [])))];

// The command line: `bun run scenarios.ts check` (prints the run lines, exits 1 with the problems when the list is unsound) and `bun run scenarios.ts files` (prints the files, for make).
if (import.meta.main) {
  const command = process.argv[2];
  const report = readFileSync(process.env['M6_EXIT_REPORT'] ?? path.join(repoRoot, 'docs/proof/m6-exit.md'), 'utf8'); // the variable is for the test of this list: another report
  if (command === 'check') {
    const problems = [...listProblems(SCENARIOS, report), ...fileDisagreements(SCENARIOS, report), ...reportProblems(report)]; // the list, the files it names against the report's, and the report itself
    if (problems.length > 0) {
      process.stderr.write(`${problems.join('\n')}\nthe list of scenarios is not sound\n`);
      process.exit(1);
    }
    process.stdout.write(`${runLines(SCENARIOS).join('\n')}\n`);
  } else if (command === 'files') {
    process.stdout.write(`${specFiles(SCENARIOS).join(' ')}\n`);
  } else {
    process.stderr.write('usage: scenarios.ts check | files\n');
    process.exit(2);
  }
}
