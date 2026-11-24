import { test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { expectSaved } from './saved';

// Needs the whole stack: the language picker of a code block sets `language` to ts, and the saved Markdown fence reads ```ts.
test('the language picker sets ts and the saved Markdown fence reads ```ts', async ({ browser, baseURL }) => {
  const made = await makePage('# Code\n\n```\nconst a: number = 1;\n```\n', { permission: 'read_write' });
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
  try {
    await signInAs(context, 'e2e-alice', 'member');
    const page = await context.newPage();
    await page.goto(made.path);
    await waitForSynced(page);
    await page.locator('.ProseMirror pre').click();
    await page.getByRole('combobox', { name: 'Language of this code block' }).selectOption('ts');
    await expectSaved(made.id, '```ts\nconst a: number = 1;\n```');
  } finally {
    await context.close();
  }
});
