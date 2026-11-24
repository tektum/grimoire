import { existsSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../support/env.ts';
import type { Scenario } from './scenarios.ts';

const TASK = /^M\d+-T\d+[a-z]?$/;
const PATH = /`([^`]+)`/g;

/** The rows of the tables of `docs/proof/m6-exit.md` that have a state: the scenarios (first cell an id in backticks) and the behaviours (first cell an area with its task). */
export interface Row {
  readonly table: 'scenario' | 'behaviour';
  readonly label: string;
  readonly files: readonly string[];
  readonly state: string;
}

const isFile = (text: string): boolean => /^[\w.@-]+(\/[\w.@-]+)+$/.test(text);

export function rowsOf(markdown: string): Row[] {
  const rows: Row[] = [];
  let table: Row['table'] | null = null;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) table = line.startsWith('## The scenarios') ? 'scenario' : line.startsWith('## What proves each behaviour') ? 'behaviour' : null;
    if (table === null || !line.startsWith('| ') || line.startsWith('| Scenario') || line.startsWith('| Area')) continue;
    const cells = line.slice(2, -2).split(' | ');
    if (cells.length < 4) continue;
    const state = cells[cells.length - 1]!.trim();
    const files = [...(cells[cells.length - 2] ?? '').matchAll(PATH)].map((m) => m[1]!).filter(isFile);
    rows.push({ table, label: table === 'scenario' ? (/^`([^`]+)`/.exec(cells[0]!)?.[1] ?? cells[0]!) : (cells[1] ?? cells[0]!).slice(0, 70), files, state });
  }
  return rows;
}

/** What is wrong with the report: a row with no state or an unknown one, a file that is named and not there in a row that says `proved`, a `pending` row that names no task or whose files are all there already. */
export function reportProblems(markdown: string, exists: (file: string) => boolean = (file) => existsSync(path.join(repoRoot, file))): string[] {
  const problems: string[] = [];
  const rows = rowsOf(markdown);
  if (rows.filter((r) => r.table === 'scenario').length === 0) problems.push('the report has no table of scenarios');
  if (rows.filter((r) => r.table === 'behaviour').length < 20) problems.push('the report has no table of behaviours (or very few rows)');
  for (const row of rows) {
    const where = `${row.table} "${row.label}"`;
    if (row.files.length === 0 && row.state !== 'pending' && !row.state.startsWith('pending ')) problems.push(`${where} names no file`);
    const pending = /^pending (\S+)$/.exec(row.state);
    if (row.state === 'proved') {
      for (const file of row.files) if (!exists(file)) problems.push(`${where} is proved by ${file}, which is not there`);
    } else if (pending !== null) {
      if (!TASK.test(pending[1]!)) problems.push(`${where} is pending on "${pending[1]}", which is not a task id`);
      else if (row.files.length > 0 && row.files.every((file) => exists(file))) problems.push(`${where} is pending on ${pending[1]} but its files are all there: it is proved`);
    } else problems.push(`${where} has the state "${row.state}": proved, or pending and a task id`);
  }
  return problems;
}

/** The files of the scenarios of the report, by id, to compare with the list. */
export function reportFiles(markdown: string): Map<string, readonly string[]> {
  return new Map(
    rowsOf(markdown)
      .filter((r) => r.table === 'scenario')
      .map((r) => [r.label, r.files]),
  );
}

/** The scenarios of the list whose files the report states differently. */
export function fileDisagreements(scenarios: readonly Scenario[], markdown: string): string[] {
  const inReport = reportFiles(markdown);
  return scenarios.flatMap((s) => {
    const files = inReport.get(s.id);
    if (files === undefined) return [];
    return JSON.stringify([...files].sort()) === JSON.stringify([...s.specs].sort()) ? [] : [`the scenario "${s.id}" has other files in the list than in the report`];
  });
}
