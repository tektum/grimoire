import { expect, test } from '@playwright/test';
import { record } from './audit';
import { open, VISITS } from './world';

// Why the page collapses when an overlay opens on a page wider than the phone: the body's padding and the scroll-lock style the dialog library adds.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });

test('scroll lock on the wide page at 390', async ({ page, context }) => {
  await open(page, context, VISITS.find((v) => v.slug === 'page')!);
  await page.getByRole('button', { name: 'Show menu', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Show contents', exact: true }).click();
  await page.locator('.contents-search').click();
  await expect(page.locator('.modal.palette')).toBeVisible();
  const lock = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyPaddingRight: getComputedStyle(document.body).paddingRight,
    bodyMarginRight: getComputedStyle(document.body).marginRight,
    bodyOverflow: getComputedStyle(document.body).overflow,
    styles: Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '').filter((t) => /padding-right|margin-right|removed-body-scroll/.test(t)).map((t) => t.replace(/\s+/g, ' ').slice(0, 400)),
  }));
  record('390-scroll-lock', lock);
});
