import { expect, test, type Request } from '@playwright/test';
import { pointAtApi } from '../auth/support';
import { makePage } from '../editor/pages';
import { apiUrl } from '../support/env';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';

// The web origin (4173) is not the API origin (8080), in every request of a walk through the screens, and no request carries a cookie: the session is a token the page holds and sends
// itself (R11.23). The editor's socket goes to the collaboration server the stack names, and to no other address.
const WALK = (made: { collectionId: string; path: string }): string[] => [`/c/${made.collectionId}`, made.path, `${made.path}/history`, '/trash', '/help'];

test('every API request goes to the API origin, none to the web origin, no request carries a cookie, and the socket goes to the collaboration server', async ({ browser, baseURL }) => {
  test.slow();
  const web = new URL(baseURL ?? 'http://127.0.0.1:4173').origin;
  const api = new URL(apiUrl()).origin;
  expect(web, 'the client is served from an origin of its own').not.toBe(api);
  const config = (await (await fetch(`${apiUrl()}/v1/config`)).json()) as { collabUrl: string };
  const collab = new URL(config.collabUrl.replace(/^ws/, 'http')).origin;
  expect(collab, 'the collaboration server is not the web server').not.toBe(web);
  const made = await makePage('# Origins\n\nA page to walk through.\n');
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(context, 'e2e-origins', 'member');
    const page = await context.newPage();
    await pointAtApi(page); // the built config.json names localhost; the stack is reached at the address the specifications use
    const requests: Request[] = [];
    const sockets: string[] = [];
    const errors: string[] = [];
    page.on('request', (request) => requests.push(request));
    page.on('websocket', (socket) => sockets.push(socket.url()));
    page.on('pageerror', (error) => errors.push(`script error: ${error.message}`));
    page.on('console', (message) => message.type() === 'error' && !/^Failed to load resource/.test(message.text()) && errors.push(`console: ${message.text()}`));
    for (const path of WALK(made)) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      if (path === made.path) await waitForSynced(page);
    }
    const seen = requests.filter((r) => /^https?:/.test(r.url()));
    expect(seen.length, 'the walk made requests').toBeGreaterThan(10);
    const apiCalls = seen.filter((r) => new URL(r.url()).pathname.startsWith('/v1/'));
    expect(apiCalls.length, 'and some of them are API calls').toBeGreaterThan(3);
    for (const call of apiCalls) expect(new URL(call.url()).origin, `${call.method()} ${new URL(call.url()).pathname}`).toBe(api);
    for (const request of seen) {
      const headers = await request.allHeaders();
      expect(headers['cookie'], `${request.method()} ${request.url()} carries no cookie`).toBeUndefined();
    }
    expect(errors, 'no script error and no console error').toEqual([]);
    expect(await context.cookies(), 'no cookie is set for either origin').toEqual([]);
    expect(sockets.length, 'the editor opened its socket').toBeGreaterThan(0);
    for (const socket of sockets) expect(new URL(socket.replace(/^ws/, 'http')).origin, 'the socket goes to the collaboration server the stack names').toBe(collab);
  } finally {
    await context.close();
  }
});

// With the client served with its rendered headers (`make test-m6` renders them for the running stack and serves with them), the page has a content security policy and breaks none of it.
test('served with its rendered headers, the page has a content security policy and breaks none of it', async ({ browser, baseURL }) => {
  test.skip(process.env['GRIMOIRE_WEB_HEADERS_DIR'] === undefined, 'only when the client is served with its rendered headers (make test-m6 sets GRIMOIRE_WEB_HEADERS_DIR)');
  test.slow();
  const made = await makePage('# Policy\n\nA page under its policy.\n');
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(context, 'e2e-policy', 'member');
    await context.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener('securitypolicyviolation', (event) => (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    const page = await context.newPage();
    await pointAtApi(page);
    const documents: string[] = [];
    page.on('response', (response) => response.request().resourceType() === 'document' && documents.push(response.headers()['content-security-policy'] ?? ''));
    const violations: string[] = [];
    for (const path of WALK(made)) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      if (path === made.path) await waitForSynced(page);
      violations.push(...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])));
    }
    expect(documents.length).toBeGreaterThan(0);
    for (const policy of documents) expect(policy, 'every document of the walk is served with a content security policy').toMatch(/default-src|script-src/);
    expect(violations, 'and breaks none of its own content-security rules').toEqual([]);
  } finally {
    await context.close();
  }
});
