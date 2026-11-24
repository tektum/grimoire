// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(config).toContain("command: 'node scripts/serve.mjs'");
    expect(config).toContain("E2E_API_URL'] ?? 'http://127.0.0.1:8080'");
    expect(config.match(/width: 1280, height: 800/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe('the port and the server of the run', () => {
  const load = async (port?: string) => {
    vi.resetModules();
    delete process.env['CI']; // the setting must not depend on it
    if (port === undefined) delete process.env['E2E_WEB_PORT'];
    else process.env['E2E_WEB_PORT'] = port;
    return (await import('../../playwright.config')).default;
  };
  const ci = process.env['CI'];
  afterEach(() => {
    delete process.env['E2E_WEB_PORT'];
    if (ci !== undefined) process.env['CI'] = ci;
  });

  it('serves on 4173 unless E2E_WEB_PORT says otherwise, and the server, the address and the port agree', async () => {
    for (const [asked, port] of [[undefined, '4173'], ['4999', '4999']] as const) {
      const c = await load(asked);
      const server = c.webServer as { url: string; env: Record<string, string> };
      expect([c.use?.baseURL, server.url, server.env['PORT']]).toEqual([`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}/`, port]);
    }
  });
  it('never reuses a server it did not start: another checkout may be serving a different build on that port', async () => {
    expect((await load()).webServer).toMatchObject({ reuseExistingServer: false });
  });
  it('refuses a port that is not a port', async () => {
    for (const bad of ['abc', '0', '70000', '41.5', '']) await expect(load(bad)).rejects.toThrow(/E2E_WEB_PORT/);
  });

  it('has one name for the port: the stack overlay reads the same E2E_WEB_PORT, with the same default, and no second variable exists', async () => {
    const overlay = readFileSync(path.join(web, '../../compose.m6.yaml'), 'utf8');
    const fromOverlay = [...overlay.matchAll(/\$\{E2E_WEB_PORT:-(\d+)\}/g)].map((m) => m[1]);
    expect(fromOverlay).toHaveLength(2); // the 127.0.0.1 and the localhost origin
    const server = (await load()).webServer as { env: Record<string, string> };
    expect(new Set(fromOverlay)).toEqual(new Set([server.env['PORT']])); // the overlay's default is the configuration's
    expect(config).toContain("process.env['E2E_WEB_PORT']");
    expect(overlay + config).not.toContain('M6_WEB_PORT');
  });
});
