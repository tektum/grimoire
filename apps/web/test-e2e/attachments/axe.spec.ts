import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { ID, openPage, scriptStore } from './support';

test('axe reports no serious or critical violation on a page with an image, an attachment link and the placeholder of an image that is not shown', async ({ page }) => {
  await scriptStore(page);
  const opened = await openPage(page, `# A page\n\nText before.\n\n![a green pixel](attachments/${ID}/pixel.png)\n\n![x](https://evil.test/p.png)\n\nThe plan: [plan.pdf](attachments/${ID}/plan.pdf)\n`);
  try {
    await expect(page.locator('.attachment-image[data-state="ready"]')).toHaveCount(1);
    await expectNoAxeViolations(page);
  } finally {
    await opened.stop();
  }
});
