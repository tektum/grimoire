import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
// @ts-expect-error plain .mjs script without types
import { createServer } from '../../scripts/serve.mjs';
import { SCRIPTED_PAGE_ID, scriptedApi, useScriptedApi } from '../editor/scripted';
import { scriptedCollabServer } from '../support/collab-server';
import { signInAs } from '../support/sign-in';

// The built client, served by its own server with the headers `render-headers.mjs` renders for the three origins it talks to, signs in with a development token and opens a
// page: no console error and no report of the content security policy being violated. The API and the collaboration server are the scripted ones of the specs that need no
// stack; the origins in the policy are theirs.
const root = path.resolve(import.meta.dirname, '../..');

test('the built app, under the rendered content security policy, signs in and opens a page with no console error and no policy violation', async ({ browser }) => {
  const collab = await scriptedCollabServer();
  const api = await scriptedApi({ collabUrl: collab.url });
  const out = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'grimoire-csp-'));
  execFileSync(process.execPath, [path.join(root, 'scripts/render-headers.mjs'), '--api-origin', api.url, '--collab-origin', collab.url, '--store-origin', 'http://127.0.0.1:1', '--out', out], { stdio: 'pipe' });
  const server = createServer({ headersDir: out }) as Server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const context = await browser.newContext({ baseURL: origin });
  try {
    await signInAs(context, 'e2e-csp', 'member', { check: false });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as unknown as { __violations: string[] }).__violations = [];
      document.addEventListener('securitypolicyviolation', (event) => (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    await useScriptedApi(page, api);
    // The scripted API answers what the page screen reads; the side tree asks for the collections too, which it does not know. It is answered with a collection and a page in it, so that the tree
    // draws a row: a row that can be dragged is the part of the page that asks the browser for a drag image, which must not be loaded from a `data:` address (`img-src` has none).
    const json = (route: import('@playwright/test').Route, body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(body) });
    await page.route(`${api.url}/v1/collections**`, (route) =>
      new URL(route.request().url()).pathname.endsWith('/tree')
        ? json(route, { pages: [{ id: '22222222-2222-4222-8222-222222222222', urlId: 'row0001', parentId: null, position: 'p1', title: 'A page in the tree', icon: null }] })
        : json(route, { items: [{ id: SCRIPTED_PAGE_ID, name: 'Dev', myPermission: 'read-write' }] }),
    );
    const response = await page.goto('/p/scripted-abc123');
    expect(response?.headers()['content-security-policy'], 'the document carries the policy').toContain("script-src 'self'");
    await expect(page.getByTestId('editor-root')).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /A page in the tree/ }), 'the side tree has a row that can be dragged').toBeVisible();
    await expect.poll(() => collab.tokens.length, { message: 'the page connected to the collaboration server, which its policy allows' }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500); // a late report, if any, has come
    // The notices' styles are in a stylesheet of the app, not written into the page by the library (which `style-src 'self'` would block).
    expect(await page.evaluate(() => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule.cssText.includes('data-sonner-toaster')))), 'the notices have their stylesheet').toBe(true);
    expect(await page.evaluate(() => [...document.querySelectorAll('style')].map((e) => (e.textContent ?? '').slice(0, 60)))).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
    await api.stop();
    await collab.stop();
    rmSync(out, { recursive: true, force: true });
  }
});
