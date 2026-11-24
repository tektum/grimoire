import { expect, test, type Page } from '@playwright/test';
import { makePage, resetPageState } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { statusLine, withScriptedPage } from './support';

/**
 * One test for each row of the signal table (contracts section 6) that has a text, titled `<the row's first cell>: "<the text>"` (`test/status/rows.test.ts` checks the
 * titles against the table). The rows a real server cannot be made to produce are driven by a scripted collaboration server, with the app in a real browser, and each
 * checks the words the person sees.
 */
const refused = (reason: string) => ({ onAuth: { deny: reason } }) as const;
const stateless = (message: Record<string, unknown>) => JSON.stringify({ grimoire: 1, ...message });
const shown = (page: Page, text: string) => expect(statusLine(page)).toHaveText(text);

const BUSY = 'The server is busy. Trying again.';
const CANNOT = "This page can't be opened right now. Trying again.";

test.describe('the messages of the signal table', () => {
  test('bad-document-name; 4400: "Something went wrong opening this page. Reload."', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, refused('bad-document-name'), async ({ page }) => shown(page, 'Something went wrong opening this page. Reload.'));
  });

  test('invalid-token; 4401, session-expired; 4401: "Please sign in again"', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page, collab }) => {
      await expect.poll(() => collab.tokens.length).toBe(1);
      collab.closeAll(4401, 'session-expired');
      await page.clock.runFor(5_000);
      await expect(page).toHaveURL(/\/login\?.*reason=expired/);
      await expect(page.getByText('Please sign in again')).toBeVisible();
    });
  });

  test('forbidden; 4403: "You no longer have access to this page"', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, refused('forbidden'), async ({ page }) => shown(page, 'You no longer have access to this page'));
  });

  test('not-found; 4404: "Page not found"', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, refused('not-found'), async ({ page }) => {
      await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
    });
  });

  test('page-full; 4413: "This page already has 100 people editing. Try again in a moment."', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, refused('page-full'), async ({ page }) => shown(page, 'This page already has 100 people editing. Try again in a moment.'));
  });

  for (const reason of ['server-full', 'documents-full', 'memory-guard', 'try-again']) {
    test(`${reason}; 4503: "${BUSY}"`, async ({ browser, baseURL }) => {
      await withScriptedPage(browser, baseURL, refused(reason), async ({ page }) => shown(page, BUSY));
    });
  }

  for (const reason of ['state-corrupt', 'internal-error']) {
    test(`${reason}; 4500: "${CANNOT}"`, async ({ browser, baseURL }) => {
      await withScriptedPage(browser, baseURL, refused(reason), async ({ page }) => shown(page, CANNOT));
    });
  }

  test('seed-failed; 4501: "This page can\'t be opened right now. Try again", a button, and no automatic attempt', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, refused('seed-failed'), async ({ page, collab }) => {
      await shown(page, "This page can't be opened right now. Try again");
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await page.clock.runFor(10 * 60_000); // any automatic attempt would have fired
      expect(collab.tokens).toHaveLength(1);
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect.poll(() => collab.tokens.length, { message: 'exactly one attempt, on the person\'s asking' }).toBe(2);
    });
  });

  test('any unknown reason: "' + CANNOT + '"', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, refused('a-reason-no-client-has-seen'), async ({ page }) => shown(page, CANNOT));
  });

  test('close rate-limited; 4429: "You are sending changes faster than the server accepts. Trying again."', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page, collab }) => {
      await expect.poll(() => collab.tokens.length).toBe(1);
      collab.sendStateless(stateless({ kind: 'refusal', code: 'rate-limited' }));
      collab.closeAll(4429, 'rate-limited'); // the server sends the refusal and then closes: one event
      await shown(page, 'You are sending changes faster than the server accepts. Trying again.');
    });
  });

  test('1009 (raw message too big): "This page is too large to edit further. You can still read it."', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page, collab }) => {
      await expect.poll(() => collab.tokens.length).toBe(1);
      collab.closeAll(1009);
      await shown(page, 'This page is too large to edit further. You can still read it.');
    });
  });

  test('stateless state-cap: "This page is too large to edit further. You can still read it."', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page, collab }) => {
      await expect.poll(() => collab.tokens.length).toBe(1);
      collab.sendStateless(stateless({ kind: 'refusal', code: 'state-cap' }));
      await shown(page, 'This page is too large to edit further. You can still read it.');
    });
  });

  test('stateless warning state-warning: "This page is close to its size limit."', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, { statelessOnAuth: stateless({ kind: 'warning', code: 'state-warning' }) }, async ({ page }) => {
      await expect(page.locator('.page-banner')).toHaveText('This page is close to its size limit.');
    });
  });

  test('client-too-old; 4426: "A new version is available. Reload."', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, refused('client-too-old'), async ({ page }) => shown(page, 'A new version is available. Reload.'));
  });

  // Needs the whole stack: the page is reset under a tab that holds words the server has not got, and the notice is the one that goes with the copy offered.
  test('stale-epoch; 4409: "This page was reset. Your unsent changes were not applied."', async ({ browser, baseURL }) => {
    const made = await makePage('# Reset\n\nThe page as saved.\n');
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-alice', 'member');
      const page = await context.newPage();
      await page.goto(made.path);
      await waitForSynced(page);
      await page.locator('.ProseMirror p', { hasText: 'The page as saved.' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' My unsent words.');
      await resetPageState(made.id, { confirmStale: true });
      await expect(page.getByRole('alert').filter({ hasText: 'This page was reset. Your unsent changes were not applied.' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('sign-in service unavailable: "Sign-in is unavailable. Trying again."', async ({ browser, baseURL }) => {
    // The provider reports a token function that failed as an authentication failure whose reason starts with this text.
    await withScriptedPage(browser, baseURL, refused('Failed to get token: the sign-in service is unavailable'), async ({ page }) => shown(page, 'Sign-in is unavailable. Trying again.'));
  });

  test('provider scope read-only after authentication: "Read only"', async ({ browser, baseURL }) => {
    await withScriptedPage(
      browser,
      baseURL,
      {},
      async ({ page }) => {
        await expect(page.getByText('Read only', { exact: true })).toBeVisible();
      },
      async (page) => {
        await page.route('**/v1/pages/by-url-id/**', async (route) => {
          const response = await route.fetch();
          const body = (await response.json()) as Record<string, unknown>;
          await route.fulfill({ response, json: { ...body, myPermission: 'read-only' } });
        });
      },
    );
  });
});
