import { expect, type Page, test } from '@playwright/test';
import { DEV_TOKEN_PATTERN } from '../../test/support/dev-token';
import { axeViolations, expectNoAxeViolations, formatViolations } from './axe';
import { scriptedCollabServer } from './collab-server';
import { apiUrl } from './env';
import { fixtureServer, type FixtureServer } from './fixtures';
import { authMessage, parseMessage } from './hocuspocus-wire';
import { DEV_TOKEN_STORAGE_KEY, signInAs } from './sign-in';
import { twoUsers } from './two-users';

// The tooling against the real stack (`make up` with compose.m6.yaml, local mode): the API answers on E2E_API_URL. The pages are small fixtures from a
// real loopback origin (a page fulfilled by interception cannot open a WebSocket or fetch from loopback). A stub page stands in for the application: it
// keeps the token in client storage, as the client does, and the test sends that token to the API.
const STUB = '<!doctype html><html lang="en"><title>stub</title><body><main><h1>Stub</h1><p id="result">waiting</p></main></body></html>';
const BROKEN = '<!doctype html><html lang="en"><title>broken</title><body><main><h1>Broken</h1><button><svg width="10" height="10"></svg></button></main></body></html>';
const FINE = '<!doctype html><html lang="en"><title>fine</title><body><main><h1>Fine</h1><button>Save</button></main></body></html>';

let fixtures: FixtureServer;
test.beforeAll(async () => {
  fixtures = await fixtureServer({ '/stub.html': STUB, '/broken.html': BROKEN, '/fine.html': FINE });
});
test.afterAll(async () => {
  await fixtures.stop();
});

/** What the server says about the token a page keeps in client storage (the request is made from the test, with that token). */
async function whoAmI(page: Page): Promise<{ status: number; email?: string; role?: string }> {
  const token = await page.evaluate((key) => window.localStorage.getItem(key), DEV_TOKEN_STORAGE_KEY);
  const response = await page.context().request.get(`${apiUrl()}/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
  const body = response.ok() ? ((await response.json()) as { email: string; role: string }) : {};
  return { status: response.status(), ...body };
}

test.describe('signInAs and twoUsers against the stack', () => {
  test('signInAs reaches an authenticated stub: the server answers 200 to GET /v1/me with the token in storage', async ({ context }) => {
    await signInAs(context, 'e2e-self', 'member');
    const page = await context.newPage();
    await page.goto(fixtures.url('/stub.html'));
    const token = await page.evaluate((key) => window.localStorage.getItem(key), DEV_TOKEN_STORAGE_KEY);
    expect(token).toMatch(DEV_TOKEN_PATTERN);
    expect(token!.length).toBeLessThanOrEqual(256);
    expect(await whoAmI(page)).toMatchObject({ status: 200, email: 'e2e-self@dev.invalid', role: 'member' });
  });

  test('twoUsers returns two pages with different users', async ({ browser, baseURL }) => {
    const pair = await twoUsers(browser, baseURL);
    try {
      for (const who of [pair.a, pair.b]) {
        await who.page.goto(fixtures.url('/stub.html'));
      }
      const [a, b] = [await whoAmI(pair.a.page), await whoAmI(pair.b.page)];
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.email).toBe(`${pair.a.userId}@dev.invalid`);
      expect(b.email).toBe(`${pair.b.userId}@dev.invalid`);
      expect(a.email).not.toBe(b.email);
    } finally {
      await pair.close();
    }
  });
});

test.describe('scriptedCollabServer', () => {
  test('sends close code 4429 and a stateless message, and the page receives them; the server records the token', async ({ page }) => {
    const server = await scriptedCollabServer({ statelessOnAuth: '{"notice":"scripted"}' });
    try {
      await page.goto(fixtures.url('/stub.html'));
      const frame = Array.from(authMessage('page-1', 'the-token'));
      const outcome = page.evaluate(
        ([url, bytes]) =>
          new Promise<{ messages: string[]; code: number; reason: string }>((resolve) => {
            const messages: string[] = [];
            const socket = new WebSocket(url as string);
            socket.binaryType = 'arraybuffer';
            socket.onopen = () => socket.send(Uint8Array.from(bytes as number[]));
            socket.onmessage = (e) => messages.push(new TextDecoder().decode(new Uint8Array(e.data as ArrayBuffer)));
            socket.onclose = (e) => resolve({ messages, code: e.code, reason: e.reason });
            (window as unknown as { socket: WebSocket }).socket = socket;
          }),
        [server.url, frame],
      );
      await expect.poll(() => server.tokens).toEqual(['the-token']);
      await expect.poll(() => server.sockets()).toBe(1);
      // The stateless message comes right after the authenticated answer; then the server closes with 4429.
      await expect.poll(() => page.evaluate(() => (window as unknown as { socket: WebSocket }).socket.readyState)).toBe(1);
      server.closeAll(4429, 'scripted');
      const result = await outcome;
      expect(result.code).toBe(4429);
      expect(result.reason).toBe('scripted');
      expect(result.messages.some((m) => m.includes('{"notice":"scripted"}'))).toBe(true);
      expect(parseMessage(authMessage('page-1', 'the-token'))).toMatchObject({ kind: 'auth-token', token: 'the-token' });
    } finally {
      await server.stop();
    }
  });
});

test.describe('axe helper', () => {
  test('reports a deliberately broken fixture (an unlabelled button) as a serious violation, with the report', async ({ page }) => {
    await page.goto(fixtures.url('/broken.html'));
    const violations = await axeViolations(page);
    const button = violations.find((v) => v.id === 'button-name');
    expect(button).toBeDefined();
    expect(['serious', 'critical']).toContain(button!.impact);
    const report = formatViolations(violations);
    console.log(`axe report of the broken fixture:\n${report}`);
    await expect(expectNoAxeViolations(page)).rejects.toThrow(/button-name/);
  });

  test('passes a page with no violation', async ({ page }) => {
    await page.goto(fixtures.url('/fine.html'));
    await expectNoAxeViolations(page);
  });
});
