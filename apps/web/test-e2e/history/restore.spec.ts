import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { twoUsers } from '../support/two-users';
import { waitForSynced } from '../support/sync';
import { sitAndLeave, waitForRevision } from './revisions';

// Needs the whole stack (`make test-m6`), like the other `twoUsers` specs: A restores an older version, and B, who is connected to the page, shows the restored
// text within 5 seconds.
test('A restores an older version; B, connected to the page, shows the restored text within 5 s', async ({ browser, baseURL }) => {
  const made = await makePage('# Restore\n\nFirst text.\n', { permission: 'read_write' });
  const users = await twoUsers(browser, baseURL);
  try {
    const { a, b } = users;
    await sitAndLeave(a.page, made.path, ' Second text.');
    const older = await waitForRevision(made.id, (markdown) => markdown.includes('Second text.') && !markdown.includes('Third text.'));
    for (const who of [a, b]) {
      await who.page.goto(made.path);
      await waitForSynced(who.page);
    }
    await a.page.locator('.ProseMirror').click();
    await a.page.keyboard.press('Control+End');
    await a.page.keyboard.type(' Third text.');
    await expect(b.page.locator('.ProseMirror')).toContainText('Third text.');

    // The version to restore is the one recorded after the first sitting, named by its id: not "the newest in the list", which could be a later one that already holds the third text.
    await a.page.goto(`${made.path}/history/${older}`);
    await a.page.getByRole('button', { name: 'Restore this version' }).click();
    await a.page.getByRole('alertdialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore' }).click();
    await expect(a.page).toHaveURL(new RegExp(`${made.path}$`));
    // First the person who restored (was the Markdown applied on the page?), then the other (did it reach them?): a failure says which.
    await expect(a.page.locator('.ProseMirror'), 'the restored text is applied on the restoring page').not.toContainText('Third text.', { timeout: 5000 });
    await expect(b.page.locator('.ProseMirror'), 'the restored text reaches the other person').not.toContainText('Third text.', { timeout: 5000 });
    await expect(b.page.locator('.ProseMirror')).toContainText('Second text.', { timeout: 5000 });
  } finally {
    await users.close();
  }
});
