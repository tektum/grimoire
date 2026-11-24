/** The two pass targets of the screen reader pass (R11.21): the report has one section for each. */
export const PASS_TARGETS = ['NVDA with Firefox', 'VoiceOver with Safari'] as const;

/** What a section says when nobody has done the pass: the release gate treats it as open. */
export const NOT_RUN = "not run: needs the owner's machine";

const TASK_ID = /^M\d+-T\d+[a-z]?$/;
const RESULTS = ['pass', 'fail', 'not run'];

/** The problems of the report, one line each: a missing section, a section that is neither `not run` nor a table, a row with an unknown result, a `fail` row without a task id. Empty when the report is fine. */
export function proofProblems(markdown: string): string[] {
  const problems: string[] = [];
  const sections = new Map<string, string>();
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    sections.set((newline === -1 ? part : part.slice(0, newline)).trim(), newline === -1 ? '' : part.slice(newline + 1));
  }
  for (const target of PASS_TARGETS) {
    const body = sections.get(target);
    if (body === undefined) {
      problems.push(`the section "${target}" is missing`);
      continue;
    }
    const rows = body
      .split('\n')
      .filter((line) => line.trim().startsWith('|'))
      .map((line) =>
        line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim()),
      )
      .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
    const [header, ...data] = rows;
    const marked = body.split('\n').some((line) => line.trim() === NOT_RUN);
    if (header === undefined) {
      if (!marked) problems.push(`"${target}" has neither a table of results nor the line "${NOT_RUN}"`);
      continue;
    }
    const result = header.findIndex((cell) => cell.toLowerCase() === 'result');
    const task = header.findIndex((cell) => cell.toLowerCase() === 'task');
    if (result === -1 || task === -1) {
      problems.push(`the table of "${target}" needs the columns Result and Task`);
      continue;
    }
    if (data.length === 0 && !marked) problems.push(`the table of "${target}" has no rows`);
    for (const row of data) {
      const outcome = (row[result] ?? '').toLowerCase();
      const what = row[0] ?? '';
      if (!RESULTS.includes(outcome)) problems.push(`"${target}", "${what}": the result "${row[result] ?? ''}" is not pass, fail or not run`);
      else if (outcome === 'fail' && !TASK_ID.test(row[task] ?? '')) problems.push(`"${target}", "${what}": a fail row needs a task id (like M6-T05), not "${row[task] ?? ''}"`);
    }
  }
  return problems;
}
