import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { MISSING_LINE } from './check-browser.js';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-check.ts');
const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [script], { env: { PATH: process.env['PATH'] ?? '', ...env }, encoding: 'utf8' });

test.describe('the check that the browser is installed', () => {
  test('exits 1 with the exact line when the browser binary is missing', () => {
    const result = run({ GRIMOIRE_E2E_CHROMIUM_PATH: path.join(path.dirname(script), 'no-such-browser', 'chrome') });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${MISSING_LINE}\n`);
    expect(result.stdout).toBe('');
  });

  test('passes silently when the browser is there', () => {
    const result = run({});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
