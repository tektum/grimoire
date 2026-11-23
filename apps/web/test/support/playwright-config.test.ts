// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const web = path.resolve(import.meta.dirname, '../..');
const config = readFileSync(path.join(web, 'playwright.config.ts'), 'utf8');
const signIn = readFileSync(path.join(web, 'test-e2e/support/sign-in.ts'), 'utf8');

describe('keeping the development token out of what CI uploads', () => {
  it('keeps no trace in CI (a trace records the token that signInAs stores) and one for a local failure', () => {
    expect(config).toContain("trace: process.env['CI'] === undefined ? 'retain-on-failure' : 'off'");
  });
  it('checks the token with Node fetch, which a trace does not record, not with the context request', () => {
    expect(signIn).toContain('await fetch(');
    expect(signIn).not.toContain('context.request');
  });
});

describe('the projects and the server of the Playwright configuration', () => {
  it('runs chromium, firefox and webkit at 1280 by 800 against 127.0.0.1:4173 with serve.mjs', () => {
    for (const name of ['chromium', 'firefox', 'webkit']) expect(config).toContain(`name: '${name}'`);
    expect(config).toContain('http://127.0.0.1:${WEB_PORT}');
    expect(config).toContain('const WEB_PORT = 4173;');
    expect(config).toContain("command: 'node scripts/serve.mjs'");
    expect(config).toContain("E2E_API_URL'] ?? 'http://127.0.0.1:8080'");
    expect(config.match(/width: 1280, height: 800/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
