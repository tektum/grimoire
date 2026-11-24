import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { statusLine, withScriptedPage } from './support';

// axe reports no serious or critical violation with each message of the table shown on the page screen (the offline text and Saved included).
const stateless = (message: Record<string, unknown>) => JSON.stringify({ grimoire: 1, ...message });
const REFUSALS: readonly (readonly [string, string])[] = [
  ['bad-document-name', 'Something went wrong opening this page. Reload.'],
  ['forbidden', 'You no longer have access to this page'],
  ['page-full', 'This page already has 100 people editing. Try again in a moment.'],
  ['try-again', 'The server is busy. Trying again.'],
  ['state-corrupt', "This page can't be opened right now. Trying again."],
  ['client-too-old', 'A new version is available. Reload.'],
  ['Failed to get token: the sign-in service is unavailable', 'Sign-in is unavailable. Trying again.'],
];

test.describe('axe, with each message shown', () => {
  for (const [reason, text] of REFUSALS) {
    test(`"${text}"`, async ({ browser, baseURL }) => {
      await withScriptedPage(browser, baseURL, { onAuth: { deny: reason } }, async ({ page }) => {
        await statusLine(page).filter({ hasText: text }).waitFor();
        await expectNoAxeViolations(page, { minImpact: 'serious' });
      });
    });
  }

  test('"seed-failed": the message with its Try again button', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, { onAuth: { deny: 'seed-failed' } }, async ({ page }) => {
      await page.getByRole('button', { name: 'Try again' }).waitFor();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });
  });

  test('"This page is too large to edit further. You can still read it."', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page, collab }) => {
      await expect.poll(() => collab.tokens.length).toBe(1); // the socket is open and has authenticated
      collab.sendStateless(stateless({ kind: 'refusal', code: 'state-cap' }));
      await statusLine(page).filter({ hasText: 'too large' }).waitFor();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });
  });

  test('"This page is close to its size limit." (the banner)', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, { statelessOnAuth: stateless({ kind: 'warning', code: 'state-warning' }) }, async ({ page }) => {
      await page.locator('.page-banner').waitFor();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });
  });

  test('"Offline: changes kept in this tab"', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page, collab }) => {
      await collab.stop();
      await page.clock.runFor(11_000);
      await statusLine(page).filter({ hasText: 'Offline: changes kept in this tab' }).waitFor();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });
  });
});
