import { expect, test, type Page } from '@playwright/test';
import { bundleHarness } from '../collections/bundle';
import { fixtureServer } from '../support/fixtures';

// The application's own rule for links (`isSafeHref`, and the schema that drops what it refuses) is not the only guard: Milkdown draws `href=""` for any address whose
// scheme is not one of its short list. These checks keep that second guard honest: if a Milkdown upgrade stopped doing it, this fails and says so, instead of the page
// quietly resting on one guard.
const BLANKED = ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'blob:https://a.test/1'];

async function openStock(page: Page, markdown: string) {
  const bundle = await bundleHarness('../safety/milkdown-guard-harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><meta charset="utf-8"><title>Milkdown</title><div id="host"></div>' });
  await page.goto(server.url(`/?md=${encodeURIComponent(markdown)}`));
  await page.addStyleTag({ content: bundle.css });
  await page.addScriptTag({ content: bundle.js });
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  return { origin: server.url('/'), stop: () => server.stop() };
}

test.describe("Milkdown's own guard for links", () => {
  test('draws href="" for the schemes it does not know (javascript, data, vbscript, file, blob), and keeps the ones it does', async ({ page }) => {
    const links = [...BLANKED.map((address, i) => `[blank${String(i)}](${address})`), '[kept](https://a.test/x)', '[mail](mailto:a@b.test)', '[ftp](ftp://a.test/x)'];
    const opened = await openStock(page, links.join('\n\n'));
    try {
      const hrefs = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('a')].map((a) => [a.textContent ?? '', a.getAttribute('href')])));
      for (let i = 0; i < BLANKED.length; i++) expect([`blank${String(i)}`, hrefs[`blank${String(i)}`]]).toEqual([`blank${String(i)}`, '']);
      expect(hrefs['kept']).toBe('https://a.test/x');
      expect(hrefs['mail']).toBe('mailto:a@b.test');
      expect(hrefs['ftp']).toBe('ftp://a.test/x');
    } finally {
      await opened.stop();
    }
  });

  test('a click on an ftp: link does not navigate the page', async ({ page }) => {
    const opened = await openStock(page, '[the ftp file](ftp://files.example.test/x)');
    try {
      const navigations: string[] = [];
      page.on('framenavigated', (frame) => navigations.push(frame.url()));
      const popups: string[] = [];
      page.on('popup', (popup) => popups.push(popup.url()));
      const before = page.url();
      await page.getByText('the ftp file').click();
      await page.waitForTimeout(300);
      expect(page.url()).toBe(before);
      expect(navigations).toEqual([]);
      expect(popups).toEqual([]);
    } finally {
      await opened.stop();
    }
  });
});
