import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ID } from './fake-provider.mjs';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
const check = fileURLToPath(new URL('../check.mjs', import.meta.url));

// Runs the live checker as a child process (async, so the in-process fake keeps serving).
export function runCheck(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [check], { env: { PATH: process.env.PATH, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
export const goodEnv = (url) => ({ DESCOPE_DEV_PROJECT_ID: PROJECT_ID, DESCOPE_DEV_TEST_LOGIN: 'tester@example.invalid', DESCOPE_DEV_MANAGEMENT_KEY: 'mgmt-secret', DESCOPE_DEV_BASE_URL: url });
