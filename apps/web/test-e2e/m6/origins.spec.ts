import { expect, test, type Request } from '@playwright/test';
import { makePage } from '../editor/pages';
import { apiUrl } from '../support/env';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';

// The web origin (4173) is not the API origin (8080), in every request of a walk through the screens, and no request carries a cookie: the session is a token the page holds and sends
// itself (R11.23). The requests of the editor's own socket are the socket's: its address is checked to be the collaboration server's, not the web server's.
test('every API request goes to the API origin, none to the web origin, and no request carries a cookie', async ({ browser, baseURL }) => {
  test.slow();
  const web = new URL(baseURL ?? 'http://127.0.0.1:4173').origin;
  const api = new URL(apiUrl()).origin;
  expect(web, 'the client is served from an origin of its own').not.toBe(api);
  const made = await makePage('# Origins\n\nA page to walk through.\n');
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(context, 'e2e-origins', 'member');
    const page = await context.newPage();
    const requests: Request[] = [];
    const errors: string[] = [];
    await context.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener('securitypolicyviolation', (event) => (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    const sockets: string[] = [];
    page.on('request', (request) => requests.push(request));
    page.on('websocket', (socket) => sockets.push(socket.url()));
    page.on('pageerror', (error) => errors.push(`script error: ${error.message}`));
    page.on('console', (message) => message.type() === 'error' && !/^Failed to load resource/.test(message.text()) && errors.push(`console: ${message.text()}`));
    const violations: string[] = [];
    for (const path of [`/c/${made.collectionId}`, made.path, `${made.path}/history`, '/trash', '/help']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      if (path === made.path) await waitForSynced(page);
      violations.push(...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])));
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
    expect(violations, 'the page, served with its rendered headers, breaks none of its own content-security rules').toEqual([]);
    expect(errors, 'and no script error or console error').toEqual([]);
    expect(await context.cookies(), 'no cookie is set for either origin').toEqual([]);
    expect(sockets.length, 'the editor opened its socket').toBeGreaterThan(0);
    for (const socket of sockets) expect(new URL(socket.replace(/^ws/, 'http')).origin, 'the socket goes to the collaboration server').not.toBe(web);
  } finally {
    await context.close();
  }
});
