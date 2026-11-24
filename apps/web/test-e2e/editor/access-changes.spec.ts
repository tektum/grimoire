import { expect, test } from '@playwright/test';
import { buildDevToken } from '../../test/support/dev-token';
import { mapSignal } from '../../src/editor/core/map-signal';
import { apiUrl, devSecret } from '../support/env';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage, readPage, setDefaultPermission, setSuspended, whoIs } from './pages';
import { probe, token } from './probe';
import { recreateApp } from './stack';

test.describe('an administrator changes access under an open page', () => {
  test('access taken away: every denial of a page looks the same, so the page shows "Page not found" and the server refuses the person with not-found', async ({ browser, baseURL }) => {
    test.slow(); // the app is recreated twice
    const made = await makePage('# Closed\n\nA page that is closed to its reader.\n');
    await recreateApp({ M6_RECHECK_SECONDS: '2' });
    try {
      const users = await twoUsers(browser, baseURL);
      try {
        const { page } = users.b;
        await page.goto(made.path);
        await waitForSynced(page);
        await setDefaultPermission(made.collectionId, null);
        await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('editor-root')).toHaveCount(0);

        // What the server says to the same person asking again: the refusal the client has a row for, and a close handled alike.
        const config = (await (await fetch(`${apiUrl()}/v1/config`)).json()) as { collabUrl: string };
        const seen = await probe(page, { collabUrl: config.collabUrl, documentName: made.id, handshake: token(buildDevToken(devSecret(), users.b.userId, 'member')) });
        console.log(`access removed observed ${JSON.stringify(seen)}`);
        expect(seen.denied, 'the reason of the refusal').toBe('not-found');
        expect(mapSignal({ type: 'authenticationFailed', reason: seen.denied! })).toMatchObject({ behaviour: 'NOT_FOUND' });
        expect(seen.close, 'the socket is closed after the refusal').not.toBeNull();
        expect(seen.close!.reason).toBe('not-found');
        expect(mapSignal({ type: 'close', code: seen.close!.code, reason: seen.close!.reason })).toEqual(mapSignal({ type: 'authenticationFailed', reason: 'not-found' }));
      } finally {
        await users.close();
      }
    } finally {
      await recreateApp();
    }
  });

  test('a person who is suspended: the account is signed out ("Your account is suspended"), and the server refuses their sockets with forbidden', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('# Suspended\n\nA page open in the tab of a person who is then suspended.\n');
    await recreateApp({ M6_RECHECK_SECONDS: '2' });
    try {
      const users = await twoUsers(browser, baseURL);
      try {
        const bob = await whoIs(users.b.userId);
        try {
          const { page } = users.b;
          await page.goto(made.path);
          await waitForSynced(page);
          await setSuspended(bob.id, true);
          // The re-check closes the socket, the page asks the API again, and the API refuses every request of a suspended account: the client signs it out. (That the editor stops
          // with "You no longer have access to this page" on a `forbidden` is driven in `signal-rows.spec.ts`; here the sign-out comes first.)
          await expect(page).toHaveURL(/\/login\?.*reason=suspended/, { timeout: 30_000 });
          await expect(page.getByText('Your account is suspended')).toBeVisible();

          // The server's answer to the same person asking again, from the other person's page (the suspended one is signed out).
          const config = (await (await fetch(`${apiUrl()}/v1/config`)).json()) as { collabUrl: string };
          await users.a.page.goto('/'); // a page of the app: the server only accepts sockets that come from its origin
          const seen = await probe(users.a.page, { collabUrl: config.collabUrl, documentName: made.id, handshake: token(buildDevToken(devSecret(), users.b.userId, 'member')) });
          console.log(`forbidden observed ${JSON.stringify(seen)}`);
          expect(seen.denied, 'the reason of the refusal').toBe('forbidden');
          expect(mapSignal({ type: 'authenticationFailed', reason: seen.denied! })).toMatchObject({ behaviour: 'NO_ACCESS' });
          expect(seen.close, 'the socket is closed after the refusal').not.toBeNull();
          expect(seen.close!.reason).toBe('forbidden');
          expect(mapSignal({ type: 'close', code: seen.close!.code, reason: seen.close!.reason })).toEqual(mapSignal({ type: 'authenticationFailed', reason: 'forbidden' }));
        } finally {
          await setSuspended(bob.id, false); // the other specs sign in as this person
        }
      } finally {
        await users.close();
      }
    } finally {
      await recreateApp();
    }
  });

  test('write access taken down to read: the page goes read-only, keeps its text and does not offer a copy, and the page is not reset', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('# Lowered\n\nA page whose editor is lowered to a reader.\n');
    await recreateApp({ M6_RECHECK_SECONDS: '2' });
    try {
      const users = await twoUsers(browser, baseURL);
      try {
        const { page } = users.b;
        await page.goto(made.path);
        await waitForSynced(page);
        const surface = page.locator('.ProseMirror');
        await expect(surface).toHaveAttribute('contenteditable', 'true');
        const before = await readPage(made.id);
        await setDefaultPermission(made.collectionId, 'read');
        await expect(surface).toHaveAttribute('contenteditable', 'false', { timeout: 30_000 });
        await expect(page.getByText('Read only')).toBeVisible();
        await expect(surface).toContainText('A page whose editor is lowered to a reader.');
        await expect(page.getByText('This page was reset. Your unsent changes were not applied.')).toHaveCount(0);
        expect((await readPage(made.id)).stateEpoch, 'no reset: the epoch is the same').toBe(before.stateEpoch);
      } finally {
        await users.close();
      }
    } finally {
      await recreateApp();
    }
  });
});
