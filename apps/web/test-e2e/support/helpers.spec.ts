import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { DEV_TOKEN_PATTERN } from '../../test/support/dev-token';
import { DEV_TOKEN_EXPIRES_STORAGE_KEY, DEV_TOKEN_STORAGE_KEY, signInAs } from './sign-in';
import { shotPath, shots } from './shots';
import { twoUsers } from './two-users';
import { waitForSynced } from './sync';

// The helpers against a stand-in for the API (no stack needed): it accepts only the bearer built from SECRET and records what it was sent.
// The same helpers run against the real server in self-test.spec.ts.
const SECRET = 'e2e-helpers-secret-0123456789abcdef';
const STUB = '<!doctype html><title>stub</title><main data-testid="stub">stub</main>';
let api: http.Server;
let seen: string[] = [];
let shotsDir: string;
const saved: Record<string, string | undefined> = {};

test.beforeAll(async () => {
  api = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    seen.push(auth);
    const ok = auth.startsWith(`Bearer dev:${SECRET}:`);
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { id: 'x' } : { error: { code: 'unauthenticated' } }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  shotsDir = mkdtempSync(path.join(tmpdir(), 'grimoire-shots-'));
  for (const [key, value] of Object.entries({ E2E_API_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, E2E_DEV_TOKEN_SECRET: SECRET, E2E_SHOTS_DIR: shotsDir })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
test.afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise((resolve) => api.close(resolve));
  rmSync(shotsDir, { recursive: true, force: true });
});
test.beforeEach(async ({ context }) => {
  seen = [];
  await context.route('**/stub.html', (route) => route.fulfill({ contentType: 'text/html', body: STUB }));
});

test.describe('signInAs', () => {
  test('stores a token of the grammar under the client storage key and has the server accept it', async ({ context }) => {
    const user = await signInAs(context, 'e2e-carol', 'admin');
    expect(user).toEqual({ userId: 'e2e-carol', role: 'admin' });
    expect(seen).toEqual([`Bearer dev:${SECRET}:e2e-carol:admin`]);
    const page = await context.newPage();
    await page.goto('/stub.html');
    const token = await page.evaluate((key) => window.localStorage.getItem(key), DEV_TOKEN_STORAGE_KEY);
    expect(token).toMatch(DEV_TOKEN_PATTERN);
    expect(token).toBe(`dev:${SECRET}:e2e-carol:admin`);
    // The client reads a token together with when it ends: one hour from now, as the sign-in form stores it.
    const expires = Number(await page.evaluate((key) => window.localStorage.getItem(key), DEV_TOKEN_EXPIRES_STORAGE_KEY));
    expect(expires).toBeGreaterThan(Date.now() + 3_500_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  test('refuses an uppercase user id before any request, with a plain line', async ({ context }) => {
    await expect(signInAs(context, 'Carol')).rejects.toThrow('lowercase letters, digits, - or _');
    expect(seen).toEqual([]);
  });

  test('fails with one line, not showing the secret, when the server refuses the token', async ({ context }) => {
    const before = process.env['E2E_DEV_TOKEN_SECRET'];
    process.env['E2E_DEV_TOKEN_SECRET'] = 'another-secret-0123456789abcdef-xyz';
    try {
      const error = await signInAs(context, 'e2e-carol').catch((e: Error) => e);
      expect(String((error as Error).message)).toContain('GET /v1/me answered 401');
      expect(String((error as Error).message)).not.toContain('another-secret');
    } finally {
      process.env['E2E_DEV_TOKEN_SECRET'] = before;
    }
  });
});

test.describe('twoUsers', () => {
  test('gives two pages in separate contexts, signed in as different users', async ({ browser, baseURL }) => {
    const pair = await twoUsers(browser, baseURL);
    try {
      expect(pair.a.userId).not.toBe(pair.b.userId);
      expect(pair.a.context).not.toBe(pair.b.context);
      const tokens: string[] = [];
      for (const who of [pair.a, pair.b]) {
        await who.context.route('**/stub.html', (route) => route.fulfill({ contentType: 'text/html', body: STUB }));
        await who.page.goto('/stub.html');
        tokens.push((await who.page.evaluate((key) => window.localStorage.getItem(key), DEV_TOKEN_STORAGE_KEY)) ?? '');
      }
      expect(tokens[0]).toBe(`dev:${SECRET}:e2e-alice:member`);
      expect(tokens[1]).toBe(`dev:${SECRET}:e2e-bob:member`);
    } finally {
      await pair.close();
    }
  });

  test('refuses the same user twice', async ({ browser, baseURL }) => {
    await expect(twoUsers(browser, baseURL, { a: { userId: 'same' }, b: { userId: 'same' } })).rejects.toThrow('two different user ids');
  });
});

test.describe('waitForSynced', () => {
  test('resolves when the editor root reaches data-collab-state="synced", and times out when it never does', async ({ page }) => {
    await page.route('**/stub.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `${STUB}<script>setTimeout(()=>{const e=document.createElement('div');e.setAttribute('data-collab-state','synced');document.body.append(e)},300)</script>`,
      }),
    );
    await page.goto('/stub.html');
    await waitForSynced(page);
    await page.route('**/never.html', (route) => route.fulfill({ contentType: 'text/html', body: `${STUB}<div data-collab-state="connecting"></div>` }));
    await page.goto('/never.html');
    await expect(waitForSynced(page, { timeout: 500 })).rejects.toThrow(/Timeout/);
  });
});

test.describe('shots', () => {
  test('writes a light and a dark picture of 1280 by 800 and masks password inputs', async ({ page }) => {
    await page.route('**/form.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><body style="margin:0"><input id="p" type="password" style="position:absolute;left:100px;top:100px;width:300px;height:40px;background:#c00;color:#c00"></body>',
      }),
    );
    await page.goto('/form.html');
    await page.fill('#p', 'hunter2hunter2');
    const dark = () => page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    const before = await dark();
    const files = await shots(page, 'm6-t01a', 'form');
    // The page is left as it was found: the dark picture does not leave dark mode on for what the test does next.
    expect(await dark()).toBe(before);
    expect(files.map((f) => path.relative(shotsDir, f))).toEqual(['m6-t01a/form-light.png', 'm6-t01a/form-dark.png']);
    for (const file of files) {
      const png = readFileSync(file);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 800]);
      // The masked field is painted one flat grey, not the red it has on the page.
      const probe = await page.context().newPage();
      const pixel = await probe.evaluate(async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const c = canvas.getContext('2d')!;
        c.drawImage(image, 0, 0);
        return Array.from(c.getImageData(250, 120, 1, 1).data);
      }, png.toString('base64'));
      await probe.close();
      expect(pixel.slice(0, 3)).toEqual([128, 128, 128]);
    }
  });

  test('refuses a name or task that could leave the folder', () => {
    expect(() => shotPath('m6-t01a', '../x', 'light')).toThrow('letters, digits');
    expect(() => shotPath('a/b', 'x', 'light')).toThrow('letters, digits');
    expect(() => shotPath('m6-t01a', '.hidden', 'dark')).toThrow('letters, digits');
    for (const task of ['..', '.', '.hidden']) expect(() => shotPath(task, 'x', 'light')).toThrow('letters, digits');
  });
});
