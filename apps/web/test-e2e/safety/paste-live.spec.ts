import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { pasteIntoEditor } from '../support/paste';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { expectSaved, savedMarkdown } from '../tables/saved';

// Needs the whole stack (the `Web browser tests` job): what is pasted into a live page, and what the server saves for it.
test('HTML pasted into a live page is saved as text and safe links only', async ({ browser, baseURL }) => {
  const made = await makePage('# Paste\n\nStart.\n', { permission: 'read_write' });
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(context, 'e2e-alice', 'member');
    const page = await context.newPage();
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.goto(made.path);
    await waitForSynced(page);
    await page.locator('.ProseMirror p', { hasText: 'Start.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    const html =
      '<p>Pasted <strong>words</strong>.</p><script>window.__pwned = 1</script><iframe src="https://evil.example/"></iframe>' +
      '<p onclick="window.__pwned = 2" style="background:url(https://evil.example/t.gif)">Click <a href="javascript:window.__pwned=3">here</a> or <a href="https://a.test/ok">there</a>.</p><style>p{display:none}</style>';
    await pasteIntoEditor(page, { html, text: 'Pasted words. Click here or there.' });
    await expectSaved(made.id, 'Pasted **words**.');
    const saved = await savedMarkdown(made.id);
    expect(saved).toContain('Click here or [there](https://a.test/ok).');
    for (const bad of ['<script', '<iframe', '<style', 'onclick', 'javascript:', 'evil.example']) expect([bad, saved.includes(bad)]).toEqual([bad, false]);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
    expect(dialogs).toEqual([]);
  } finally {
    await context.close();
  }
});
