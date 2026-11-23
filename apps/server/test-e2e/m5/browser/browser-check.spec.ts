import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { MISSING_LINE } from './check-browser.js';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-check.ts');
/** The check as a child process with this process's environment (a custom browsers path included), the override replaced. */
const run = (override?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['GRIMOIRE_E2E_CHROMIUM_PATH'];
  // The test runner sets FORCE_COLOR; with the user's NO_COLOR node would warn on stderr, which this test reads.
  delete env['FORCE_COLOR'];
  delete env['NO_COLOR'];
  if (override !== undefined) env['GRIMOIRE_E2E_CHROMIUM_PATH'] = override;
  return spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
};

test.describe('the check that the browser is installed', () => {
  test('exits 1 with the exact line when the browser binary is missing', () => {
    const result = run(path.join(path.dirname(script), 'no-such-browser', 'chrome'));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${MISSING_LINE}\n`);
    expect(result.stdout).toBe('');
  });

  test('passes silently when the browser is there', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
