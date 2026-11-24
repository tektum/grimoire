import { expect, test, type Page } from '@playwright/test';
import { scriptedCollabServer, type ScriptedCollabServerOptions } from '../support/collab-server';
import { signInAs } from '../support/sign-in';
import { recordHandshakes } from './handshakes';
import { probe } from './probe';
import { scriptedApi, useScriptedApi } from './scripted';

/**
 * The rows of the signal table that the real server cannot be made to produce from a browser spec (`forbidden`, `access-changed`, `session-expired`,
 * `page-full`) are driven here by a scripted collaboration server, with the app in a real browser: each says what the page shows and does.
 */
/**
 * A later sentinel event: after the page's own attempts (made on a clock the test moves, over a real socket that reaches the server a moment later), a socket
 * of the test's own is refused by the same scripted server. Its token arriving means the server has taken everything the page sent before it; what
 * counts for the checks is the tokens that are not the sentinel's.
 */
const SENTINEL = 'sentinel';
async function settledTokens(page: Page, collab: { url: string; tokens: string[] }): Promise<string[]> {
  await probe(page, { collabUrl: collab.url, documentName: SENTINEL, handshake: SENTINEL, stopAtRefusal: true });
  return collab.tokens.filter((token) => token !== SENTINEL);
}

async function withPage(
  browser: import('@playwright/test').Browser,
  baseURL: string | undefined,
  options: ScriptedCollabServerOptions,
  body: (run: { page: Page; collab: Awaited<ReturnType<typeof scriptedCollabServer>>; handshakes: ReturnType<typeof recordHandshakes> }) => Promise<void>,
): Promise<void> {
  const collab = await scriptedCollabServer(options);
  const api = await scriptedApi({ collabUrl: collab.url });
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(context, 'e2e-rows', 'member', { check: false });
    const page = await context.newPage();
    const handshakes = recordHandshakes(page);
    await page.clock.install(); // the waits of the page are the test's to move
    await useScriptedApi(page, api);
    await page.goto('/p/scripted-abc123');
    await body({ page, collab, handshakes });
  } finally {
    await context.close();
    await api.stop();
    await collab.stop();
  }
}

test.describe('the signal rows the real server cannot produce, on a scripted server', () => {
  test('forbidden: "You no longer have access to this page", the page stops and does not connect again', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, { onAuth: { deny: 'forbidden' } }, async ({ page, collab }) => {
      await expect(page.getByText('You no longer have access to this page')).toBeVisible();
      await expect(page.getByTestId('editor-root')).toHaveAttribute('data-collab-state', 'stopped');
      expect(collab.tokens).toHaveLength(1);
      await page.clock.runFor(10 * 60_000); // any retry would have fired
      expect(await settledTokens(page, collab), 'no second attempt').toHaveLength(1);
    });
  });

  test('page-full: the busy text is shown and the next attempt comes no sooner than 10 s', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, { onAuth: { deny: 'page-full' } }, async ({ page, collab }) => {
      await expect(page.getByText('This page already has 100 people editing. Try again in a moment.')).toBeVisible();
      expect(collab.tokens).toHaveLength(1);
      await page.clock.runFor(9_000);
      expect(await settledTokens(page, collab), 'no attempt before the 10 s are up').toHaveLength(1);
      await page.clock.runFor(25_000); // the wait is at least 10 s, and grows with each refusal
      await expect.poll(() => collab.tokens.filter((token) => token !== SENTINEL).length).toBeGreaterThanOrEqual(2); // the sentinel's own token is not an attempt of the page
    });
  });

  test('access-changed: the page reconnects on a fresh document, with no reset notice and no copy offered', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, {}, async ({ page, collab, handshakes }) => {
      await expect.poll(() => collab.tokens.length).toBe(1);
      collab.closeAll(4205, 'access-changed');
      await page.clock.runFor(5_000);
      await expect.poll(() => collab.tokens.length, { message: 'the reconnect' }).toBeGreaterThanOrEqual(2);
      expect(handshakes.length).toBeGreaterThanOrEqual(2);
      await expect(page.getByText('This page was reset. Your unsent changes were not applied.')).toHaveCount(0);
    });
  });

  test('session-expired: a development token cannot be refreshed, so the session ends: the person is sent to sign in again, with the page to come back to', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, {}, async ({ page, collab }) => {
      await expect.poll(() => collab.tokens.length).toBe(1);
      collab.closeAll(4401, 'session-expired');
      await page.clock.runFor(5_000);
      await expect(page).toHaveURL(/\/login\?return=%2Fp%2Fscripted-abc123&reason=expired/);
      await expect.poll(() => collab.sockets(), { message: 'the page is gone and its socket with it' }).toBe(0);
      expect(collab.tokens, 'no attempt with a token that is known to be expired').toHaveLength(1);
    });
  });
});
