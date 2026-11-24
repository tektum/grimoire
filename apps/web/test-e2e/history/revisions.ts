import { expect, type Page } from '@playwright/test';
import { buildDevToken, type DevRole } from '../../test/support/dev-token';
import { apiUrl, devSecret } from '../support/env';
import { waitForSynced } from '../support/sync';

const authorised = (userId: string, role: DevRole): Record<string, string> => ({ Authorization: `Bearer ${buildDevToken(devSecret(), userId, role)}` });

/**
 * The id of the first version of the page whose Markdown satisfies `wanted`, read through the API as an administrator, waiting for the server to record it (a
 * version is made when the last editor leaves). Polls; it never sleeps for a fixed time.
 */
export async function waitForRevision(pageId: string, wanted: (markdown: string) => boolean): Promise<string> {
  let found: string | undefined;
  await expect
    .poll(
      async () => {
        const list = await fetch(`${apiUrl()}/v1/pages/${pageId}/revisions`, { headers: authorised('e2e-admin', 'admin') });
        if (!list.ok) return undefined;
        for (const item of ((await list.json()) as { items: { id: string }[] }).items) {
          const one = await fetch(`${apiUrl()}/v1/pages/${pageId}/revisions/${item.id}`, { headers: authorised('e2e-admin', 'admin') });
          if (one.ok && wanted(((await one.json()) as { markdown: string }).markdown)) {
            found = item.id;
            return item.id;
          }
        }
        return undefined;
      },
      { timeout: 20_000, message: 'the server records a version when the last editor leaves' },
    )
    .toBeDefined();
  return found as string;
}

/** A sitting: the person opens the page, adds this text at its end, and leaves (which records a version once no one else is connected). */
export async function sitAndLeave(page: Page, path: string, added: string): Promise<void> {
  await page.goto(path);
  await waitForSynced(page);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(added);
  await expect(page.locator('.ProseMirror')).toContainText(added.trim());
  await page.goto('about:blank');
}

/** The status of a restore call made directly to the API with this person's token. */
export async function restoreStatus(pageId: string, revisionId: string, userId: string, role: DevRole): Promise<number> {
  return (await fetch(`${apiUrl()}/v1/pages/${pageId}/revisions/${revisionId}/restore`, { method: 'POST', headers: authorised(userId, role) })).status;
}
