import { expect, test } from '@playwright/test';
import { shots } from '../support/shots';
import { openEditor } from './support';

// Screenshots of a table with its controls and a cell focused, light and dark, 1280 by 800, from the editor in a page of the spec's own server
// (test-results/shots/M6-T05a/). The page text keeps its reading font; an installed sans (Liberation Sans) is named for the interface text, as in the other shots.
const TASK = 'M6-T05a';
const MARKDOWN = [
  '# Release checklist',
  'What has to be true before the autumn release goes out.',
  '| Item | Owner | State |\n| - | - | - |\n| History screens | Alice | Done |\n| Outline | Bob | In review |\n| Table controls | Carol | In progress |',
  'The table above is the one to keep up to date.',
].join('\n\n');

test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium'); });

test('a table with its controls and one cell focused, light and dark', async ({ page }) => {
  const editor = await openEditor(page, MARKDOWN, { sans: true });
  try {
    await page.locator('td', { hasText: 'Bob' }).click();
    await expect(page.getByRole('toolbar', { name: 'Table controls' })).toBeVisible();
    await page.mouse.move(0, 0);
    await shots(page, TASK, 'table-controls');
  } finally {
    await editor.stop();
  }
});
