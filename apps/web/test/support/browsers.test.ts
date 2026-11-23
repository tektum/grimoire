// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BROWSERS, MISSING_LINE, missingBrowsers } from '../../test-e2e/support/browsers';

const script = path.resolve(import.meta.dirname, '../../test-e2e/support/run-check.ts');
const empty = mkdtempSync(path.join(tmpdir(), 'grimoire-no-browsers-'));
afterAll(() => rmSync(empty, { recursive: true, force: true }));

/** The check as a child process; the browsers path is pointed at an empty directory, so no browser is found, and nothing is downloaded. */
function run(args: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty };
  delete env['FORCE_COLOR'];
  delete env['NO_COLOR'];
  return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
}

describe('the check that the browsers are installed', () => {
  it('exits 1 with the exact line, naming the install command, when no browser is there', () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${MISSING_LINE}\n`);
    expect(result.stdout).toBe('');
    expect(MISSING_LINE).toBe('playwright browsers missing: run bunx playwright install --with-deps chromium firefox webkit');
  });
  it('also fails for one browser asked for by name', () => {
    expect(run(['firefox']).status).toBe(1);
  });
  it('lists the missing browsers, all three when nothing exists, none when everything does', () => {
    expect(missingBrowsers(BROWSERS, () => false)).toEqual(['chromium', 'firefox', 'webkit']);
    expect(missingBrowsers(BROWSERS, () => true)).toEqual([]);
    expect(missingBrowsers(BROWSERS, (file) => !file.includes('webkit'))).toEqual(['webkit']);
    expect(missingBrowsers(['chromium'], () => false)).toEqual(['chromium']);
  });
});
