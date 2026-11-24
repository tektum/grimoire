import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { openReset } from './reset-support';

// The reset-state dialog (R6.21) in a browser, with the wire stood in for by route interception: it asks first, naming the page; one confirmation is one call;
// the result is shown; a replacement Markdown goes in the body; a refused replacement is shown in the server's words.
const DONE = { status: 200, body: { stateEpoch: 3, markdownStale: false } };

test('asks first, naming the page, calls reset-state once on confirmation, and shows the result', async ({ page }) => {
  const reset = await openReset(page, [DONE]);
  try {
    const dialog = page.getByRole('dialog', { name: 'Reset the saved state of Quarterly plan?' });
    await expect(dialog).toBeVisible();
    expect(reset.sent).toEqual([]);
    await dialog.getByRole('button', { name: 'Reset state' }).click();
    await expect(page.getByText('The state of Quarterly plan was reset.')).toBeVisible();
    expect(reset.sent).toEqual([{}]);
  } finally {
    await reset.stop();
  }
});

test('sends a replacement Markdown, and shows the words of a refusal (422) with the dialog still open', async ({ page }) => {
  const reset = await openReset(page, [{ status: 422, body: { error: { code: 'invalid', message: 'The text is over 131072 bytes' } } }, DONE]);
  try {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Replacement Markdown (optional)' }).fill('# Fresh start');
    await dialog.getByRole('button', { name: 'Reset state' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('The text is over 131072 bytes');
    await dialog.getByRole('button', { name: 'Reset state' }).click();
    await expect(page.getByText('The state of Quarterly plan was reset.')).toBeVisible();
    expect(reset.sent).toEqual([{ markdown: '# Fresh start' }, { markdown: '# Fresh start' }]);
  } finally {
    await reset.stop();
  }
});

test('the buttons of the dialog do not touch: a token gap lies between them', async ({ page }) => {
  const reset = await openReset(page, [DONE]);
  try {
    const dialog = page.getByRole('dialog');
    const first = await dialog.getByRole('button', { name: 'Reset state' }).boundingBox();
    const second = await dialog.getByRole('button', { name: 'Close' }).boundingBox();
    const gap = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.width = 'var(--space-2)';
      document.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    });
    expect(gap).toBeGreaterThan(0);
    expect((second?.x ?? 0) - ((first?.x ?? 0) + (first?.width ?? 0))).toBeGreaterThanOrEqual(gap - 0.5);
  } finally {
    await reset.stop();
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the dialog has no serious or critical accessibility violation (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const reset = await openReset(page, [DONE]);
    try {
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    } finally {
      await reset.stop();
    }
  });
}
