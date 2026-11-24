import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { repoRoot } from '../support/env';
import { NOT_RUN, proofProblems } from './proof-check';

// The report of the screen reader pass (docs/proof/m6-accessibility.md) is checked as a script would: no stack is needed.
const good = (nvda: string, voiceover: string): string => `# Report\n\n## NVDA with Firefox\n\n${nvda}\n\n## VoiceOver with Safari\n\n${voiceover}\n`;
const table = (...rows: string[]): string => ['| Target | Result | Task |', '|---|---|---|', ...rows].join('\n');

test('the report in the repository has both sections, and every fail row has a task id', () => {
  const report = readFileSync(`${repoRoot}/docs/proof/m6-accessibility.md`, 'utf8');
  expect(proofProblems(report)).toEqual([]);
});

test('a section that was not run says so in the exact words, and a table of results passes', () => {
  expect(proofProblems(good(NOT_RUN, NOT_RUN))).toEqual([]);
  expect(proofProblems(good(table('| the editor | pass | |', '| the tree | not run | |'), NOT_RUN))).toEqual([]);
  expect(proofProblems(good(table('| the palette | fail | M6-T09 |', '| the history | fail | M6-T07 |'), table('| the tree | fail | M6-T03 |')))).toEqual([]);
});

test('a missing section is found, for each target', () => {
  expect(proofProblems('# Report\n\n## VoiceOver with Safari\n\nnot run\n')).toContain('the section "NVDA with Firefox" is missing');
  expect(proofProblems(`# Report\n\n## NVDA with Firefox\n\n${NOT_RUN}\n`)).toContain('the section "VoiceOver with Safari" is missing');
  expect(proofProblems('')).toHaveLength(2);
});

test('a fail row without a task id is found, and so is a section that says nothing', () => {
  expect(proofProblems(good(table('| the editor | fail | |'), NOT_RUN))).toEqual(['"NVDA with Firefox", "the editor": a fail row needs a task id (like M6-T05), not ""']);
  expect(proofProblems(good(table('| the editor | fail | later |'), NOT_RUN))).toHaveLength(1);
  expect(proofProblems(good('Nothing was done.', NOT_RUN))).toEqual([`"NVDA with Firefox" has neither a table of results nor the line "${NOT_RUN}"`]);
  expect(proofProblems(good(table('| the editor | maybe | |'), NOT_RUN))[0]).toMatch(/the result "maybe" is not pass, fail or not run/);
  expect(proofProblems(good('| Target | Result |\n|---|---|\n| the editor | pass |', NOT_RUN))[0]).toMatch(/needs the columns Result and Task/);
});
