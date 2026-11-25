import { expect, test } from '@playwright/test';
import { makePage, makePagesIn, setDefaultPermission } from '../editor/pages';
import { signInAs } from '../support/sign-in';

// Search and the palette against the stack: the real `GET /v1/search` over pages made through the real API (M7-T01), signed in as a development user. The scripted specifications of this folder keep what the
// stack cannot give: a passage found by meaning (the semantic search is M7-T14) and a page too long to be searched whole (the Markdown of a page is at most 128 KiB, so none exists).
// Written for the stack (`make test-m6`, `make test-web-e2e`); not run where there is none.
const letters = (n: number): string => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
/** A word nobody else has written: one lexeme whatever the language of the index does to it. */
const rare = (): string => `quokka${letters(10)}`;

// The address of a page is `/p/<slug of the title>-<urlId>` (the search links and the page screen use the canonical one), so it is matched by its urlId at the end.
test('a page is found by a word of its body from the results screen, with the word marked, and the result opens the page', async ({ page, context }) => {
  const word = rare();
  const made = await makePage(`# Field notes\n\nThe ${word} was seen near the water, and the ${word} came back.\n`, { title: `Notes ${word}` });
  await signInAs(context, 'e2e-alice', 'member');
  await page.goto(`/search?q=${word}`);
  const result = page.getByRole('link', { name: `Notes ${word}` });
  await expect(result).toBeVisible();
  const marks = page.locator('.search-snippet mark');
  await expect(marks.first()).toBeVisible();
  for (const text of await marks.allInnerTexts()) expect(text.toLowerCase(), 'what is marked is the word').toContain('quokka');
  await result.click();
  await expect(page).toHaveURL(new RegExp(`/p/[^/?#]*-${made.urlId}`));
  await expect(page.getByTestId('editor-root')).toBeVisible();
});

test('the palette finds the same page by its word and opens it with Enter', async ({ page, context }) => {
  const word = rare();
  const made = await makePage(`# Palette\n\nOnly the ${word} is written here.\n`, { title: `Palette ${word}` });
  await signInAs(context, 'e2e-alice', 'member');
  await page.goto('/');
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill(word);
  const option = page.getByRole('option', { name: new RegExp(`Palette ${word}`) });
  await expect(option).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/p/[^/?#]*-${made.urlId}`));
});

test('more results than a page holds are got by the real cursor, and a word nobody wrote has "No results"', async ({ page, context }) => {
  const word = rare();
  const group = await makePagesIn(21, (n) => ({ title: `Sighting ${String(n).padStart(2, '0')} ${word}`, markdown: `The ${word} again, number ${String(n)}.\n` }));
  await signInAs(context, 'e2e-alice', 'member');
  await page.goto(`/search?q=${word}`);
  const items = page.locator('.search-results > li');
  await expect(items).toHaveCount(20);
  await page.getByRole('button', { name: 'Show more results' }).click();
  await expect(items).toHaveCount(group.pages.length);
  await expect(page.getByRole('button', { name: 'Show more results' })).toHaveCount(0);
  await page.goto(`/search?q=${rare()}`);
  await expect(page.getByText('No results')).toBeVisible();
});

test('a person who cannot read the collection finds nothing of it, and the words of a page are text, never markup', async ({ page, context }) => {
  const word = rare();
  const made = await makePage(`# Hidden\n\nBefore \\<img src=x onerror=alert(1)\\> the ${word} after.\n`, { title: `Hidden ${word}` });
  await signInAs(context, 'e2e-alice', 'member');
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(`/search?q=${word}`);
  await expect(page.getByRole('link', { name: `Hidden ${word}` })).toBeVisible();
  await expect(page.locator('.search-snippet img, .search-snippet script')).toHaveCount(0);
  await setDefaultPermission(made.collectionId, null);
  await page.goto(`/search?q=${word}`);
  await expect(page.getByText('No results')).toBeVisible();
  expect(dialogs).toEqual([]);
});
