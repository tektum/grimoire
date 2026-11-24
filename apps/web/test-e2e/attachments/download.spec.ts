import { expect, test } from '@playwright/test';
import { ID, logRequests, openPage, scriptStore } from './support';

test('clicking an attachment link requests a signed link at that moment (one GET /v1/attachments/{id}) and opens it; the header-less path is never requested', async ({ page }) => {
  const store = await scriptStore(page);
  const requests = logRequests(page);
  const opened = await openPage(page, `A file: [the plan](attachments/${ID}/plan.pdf)\n`);
  try {
    const link = page.locator(`a[href="attachments/${ID}/plan.pdf"]`);
    await expect(link).toBeVisible();
    expect(store.log.filter((l) => l.startsWith('GET'))).toEqual([]); // nothing is asked for before the click
    await link.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { opened?: string[] }).opened ?? [])).toEqual([`http://files.test/download/${ID}?sig=1`]);
    expect(store.log.filter((l) => l.startsWith('GET'))).toEqual([`GET /v1/attachments/${ID}`]);
    expect(requests.filter((r) => r.includes('/plan.pdf'))).toEqual([]);
  } finally {
    await opened.stop();
  }
});
