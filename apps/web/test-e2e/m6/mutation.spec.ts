import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, test } from '@playwright/test';
import ts from 'typescript';
import type { Mapping, Signal } from '../../src/editor/core/map-signal';
import { xssCorpus } from '../../test/corpus/xss';
import { failures } from '../../test/status/table';
import { repoRoot } from '../support/env';

// A check that nothing checks is worth nothing: one row of `mapSignal` and one rule of the allow-list behind `isSafeHref` are broken here, in a copy, and the table of signals and the
// list of addresses (with the corpus of hostile input) must each find it. The unchanged copies pass the same tables, so that what fails is the mutation. No stack is needed.
const mapSignalSource = readFileSync(path.join(repoRoot, 'apps/web/src/editor/core/map-signal.ts'), 'utf8');

/** `map-signal.ts` with one behaviour changed, loaded as a module of its own (the file has no imports). */
function mutatedMapSignal(from: string, to: string): (signal: Signal) => Mapping {
  expect(mapSignalSource, `the mutation applies: "${from}" is in map-signal.ts`).toContain(from);
  const js = ts.transpileModule(mapSignalSource.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported: { mapSignal?: (signal: Signal) => Mapping } = {};
  runInNewContext(js, { exports: exported });
  return exported.mapSignal!;
}

const ACCEPTED = ['https://a.test', 'http://a.test', 'mailto:a@b.test', 'tel:+1555', 'ftp://a.test/x', '/x', './x', '../x', '#a', '?q=1'];
const REFUSED = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  '\u0001javascript:alert(1)',
  '&#106;avascript:alert(1)',
  'file:///etc/passwd',
  'vbscript:msgbox(1)',
  'data:text/html,<script>alert(1)</script>',
  'blob:https://a.test/1',
  ' javascript:alert(1)',
  '%6aavascript:alert(1)',
];

interface AddressCase {
  readonly label: string;
  readonly href: string;
  readonly keep: boolean;
}

/** The addresses the allow-list must keep or refuse: the list above and every address of the corpus of hostile input. */
const addressCases = (): AddressCase[] => [
  ...ACCEPTED.map((href) => ({ label: `refuses ${JSON.stringify(href)}`, href, keep: true })),
  ...REFUSED.map((href) => ({ label: `accepts ${JSON.stringify(href)}`, href, keep: false })),
  ...xssCorpus.flatMap((e) => (e.href !== undefined && (e.expect === 'link-kept' || e.expect === 'link-refused') ? [{ label: `corpus ${e.id}`, href: e.href, keep: e.expect === 'link-kept' }] : [])),
];

const distFile = path.join(repoRoot, 'packages/editor-schema/dist/index.js');

/**
 * What the list and the corpus find wrong with the built allow-list after `change` (empty for the real one). The allow-list is copied into a folder under the repository (so that its
 * imports resolve), changed there, and run by a small module of its own in a process of its own, which prints the labels of the cases it gets wrong. The folder is removed afterwards.
 */
function allowListProblems(change?: { from: string; to: string }): string[] {
  let source: string;
  try {
    source = readFileSync(distFile, 'utf8');
  } catch {
    throw new Error('packages/editor-schema/dist/index.js is not there: the workspace is built first (bun run build)');
  }
  if (change !== undefined) expect(source, `the mutation applies: "${change.from}" is in the built schema`).toContain(change.from);
  const dir = path.join(repoRoot, 'test-results/mutants', `${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, 'index.mjs'), change === undefined ? source : source.replace(change.from, change.to));
    writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(addressCases()));
    writeFileSync(
      path.join(dir, 'run.mjs'),
      "import { readFileSync } from 'node:fs';\nimport { isSafeUrl } from './index.mjs';\nconst cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));\nprocess.stdout.write(JSON.stringify(cases.filter((c) => isSafeUrl(c.href, 'link') !== c.keep).map((c) => c.label)));\n",
    );
    const run = spawnSync('node', [path.join(dir, 'run.mjs')], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as string[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.describe('mapSignal', () => {
  test('the table passes on the unchanged source, so a failure below is the mutation', () => {
    expect(failures(mutatedMapSignal('const', 'const'))).toEqual([]);
  });

  test('one row broken (seed-failed is retried by itself) makes the table fail', () => {
    const wrong = failures(mutatedMapSignal('return error(TEXTS.cannotOpen, { noRetry: true });', 'return error(TEXTS.cannotOpen);'));
    expect(wrong.length, 'the table finds the broken row').toBeGreaterThan(0);
  });

  test('a second row broken (a client that is too old is not asked to reload) makes it fail too', () => {
    expect(failures(mutatedMapSignal("{ behaviour: 'RELOAD', text: TEXTS.tooOld }", "{ behaviour: 'RETRY' }")).length).toBeGreaterThan(0);
  });
});

test.describe('isSafeHref', () => {
  test('the list of addresses and the corpus pass on the real allow-list, so a failure below is the mutation', () => {
    expect(addressCases().length, 'the list has the corpus in it').toBeGreaterThan(30);
    expect(allowListProblems()).toEqual([]);
  });

  test('the scheme allow-list opened to every scheme makes the list and the corpus fail', () => {
    const wrong = allowListProblems({ from: 'SCHEMES[kind].has(scheme.toLowerCase())', to: 'true' });
    expect(wrong.length, `the list finds it: ${wrong.slice(0, 3).join('; ')}`).toBeGreaterThan(3);
    expect(
      wrong.some((w) => w.startsWith('corpus ')),
      'and so does the corpus',
    ).toBe(true);
    expect(wrong).toContain('accepts "javascript:alert(1)"');
  });
});
