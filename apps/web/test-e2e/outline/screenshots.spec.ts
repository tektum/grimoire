import { expect, test } from '@playwright/test';
import { historyApi, SLUG } from '../history/mock-api';
import { shots } from '../support/shots';
import { signInAs } from '../support/sign-in';

// Screenshots of the outline beside a page at 1400 pixels wide, with the current heading marked, and of the same page at 1000 pixels (no outline), light and dark
// (test-results/shots/M6-T05b/). This machine's default sans-serif is a monospace face, so an installed sans (Liberation Sans) is named for the interface text only, as in the other shots; the page text keeps the reading font of the design.
const TASK = 'M6-T05b';
const SANS = ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; }"; // the page text keeps its own reading font (--font-page)
const MARKDOWN = [
  '# Planning the autumn release',
  'The plan in one place: what ships, who does what, and what we leave for later.',
  '## Goals',
  'Ship the editor, the history and the outline. Keep the first release small.',
  '## Schedule',
  '### September',
  'Freeze the schema and finish the contents tree.',
  '### October',
  'History, restore and the admin screens.',
  '## Risks',
  'The live editor needs more testing with two people at once.',
  '# Notes',
  'Anything else goes here.',
].join('\n\n');

test.beforeEach(async ({ context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await signInAs(context, 'e2e-alice', 'member', { check: false });
});

test('the outline beside a page at 1400 pixels wide, with the current heading marked, light and dark', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await historyApi(page, { role: 'member', current: MARKDOWN, revisions: [] });
  await page.goto(`/p/${SLUG}`);
  await page.addStyleTag({ content: SANS });
  const nav = page.getByRole('navigation', { name: 'Page outline' });
  await expect(nav.getByRole('link')).toHaveCount(7);
  await nav.getByRole('link', { name: 'October' }).click();
  await expect(nav.getByRole('link', { name: 'October' })).toHaveAttribute('aria-current', 'location');
  await page.mouse.move(0, 0);
  await shots(page, TASK, 'outline', { width: 1400 });
});

test('the same page at 1000 pixels wide: no outline, light and dark', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await historyApi(page, { role: 'member', current: MARKDOWN, revisions: [] });
  await page.goto(`/p/${SLUG}`);
  await page.addStyleTag({ content: SANS });
  await expect(page.getByTestId('editor-root').locator('h1').first()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Page outline' })).toHaveCount(0);
  await page.mouse.move(0, 0);
  await shots(page, TASK, 'no-outline', { width: 1000 });
});
