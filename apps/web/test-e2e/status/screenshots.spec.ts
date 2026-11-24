import { expect, test, type Page } from '@playwright/test';
import { bundleHarness } from '../collections/bundle';
import { fixtureServer } from '../support/fixtures';
import { shots } from '../support/shots';

// Screenshots of the status line (Saved, Saving, Offline) beside the title of a page, light and dark, 1280 by 800 (test-results/shots/M6-T06/). The status line is the real
// component in the page's own styles; the page text keeps its reading font, an installed sans (Liberation Sans) is named for the interface text only.
const TASK = 'M6-T06';
const BODY = ['The plan in one place: what ships, who does what, and what we leave for later.', 'Ship the editor, the history and the outline. Keep the first release small.'];

async function open(page: Page) {
  const bundle = await bundleHarness('../status/harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page</title><main style="padding: 2rem 1rem"><div id="host"></div></main></html>' });
  await page.goto(server.url('/'));
  await page.addStyleTag({ content: bundle.css });
  await page.addStyleTag({ content: ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; }" });
  await page.addScriptTag({ content: bundle.js });
  return {
    show: (options: object) => page.evaluate((o) => (window as unknown as { show: (x: object) => void }).show(o), options),
    stop: () => server.stop(),
  };
}

test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium'); });

for (const [name, text, state, collab] of [
  ['saved', 'Saved', { unsynced: 0 }, 'synced'],
  ['saving', 'Saving', { unsynced: 2 }, 'synced'],
  ['offline', 'Offline: changes kept in this tab', { text: 'Offline: changes kept in this tab', unsynced: 2 }, 'offline'],
  ['busy', 'The server is busy. Trying again.', { text: 'The server is busy. Trying again.' }, 'connecting'],
  ['page-full', 'This page already has 100 people editing. Try again in a moment.', { text: 'This page already has 100 people editing. Try again in a moment.' }, 'connecting'],
  ['rate-limited', 'You are sending changes faster than the server accepts. Trying again.', { text: 'You are sending changes faster than the server accepts. Trying again.' }, 'connecting'],
  ['cannot-open', "This page can't be opened right now. Try again", { text: "This page can't be opened right now. Trying again.", stopped: 'cannot-open' }, 'stopped'],
  ['no-access', 'You no longer have access to this page', { text: 'You no longer have access to this page', stopped: 'no-access' }, 'stopped'],
] as const) {
  test(`the status line says ${text}, light and dark`, async ({ page }) => {
    const harness = await open(page);
    try {
      await harness.show({ title: 'Planning the autumn release', collab, state, body: BODY });
      await expect(page.getByRole('status')).toHaveText(text);
      await shots(page, TASK, name);
    } finally {
      await harness.stop();
    }
  });
}

test('the size-limit banner, light and dark', async ({ page }) => {
  const harness = await open(page);
  try {
    await harness.show({ title: 'Planning the autumn release', collab: 'synced', state: { banner: 'This page is close to its size limit.' }, body: BODY });
    await expect(page.getByText('This page is close to its size limit.')).toBeVisible();
    await shots(page, TASK, 'size-limit-banner');
  } finally {
    await harness.stop();
  }
});

test('the "too large" notice with the reset action for admins, light and dark', async ({ page }) => {
  const harness = await open(page);
  try {
    const text = 'This page is too large to edit further. You can still read it.';
    await harness.show({ title: 'Planning the autumn release', collab: 'synced', state: { text, readOnly: true }, admin: true, body: BODY });
    await expect(page.getByRole('status')).toHaveText(text);
    await expect(page.getByRole('button', { name: 'Reset saved state…' })).toBeVisible();
    await shots(page, TASK, 'too-large-admin');
  } finally {
    await harness.stop();
  }
});
