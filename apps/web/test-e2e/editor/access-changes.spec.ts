import { expect, test } from '@playwright/test';
import { buildDevToken } from '../../test/support/dev-token';
import { mapSignal } from '../../src/editor/core/map-signal';
import { apiUrl, devSecret } from '../support/env';
import { DEV_TOKEN_STORAGE_KEY } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage, readPage, setDefaultPermission, setRole, setSuspended, whoIs } from './pages';
import { probe, token } from './probe';
import { recreateApp } from './stack';

/**
 * In local mode the server takes a person's role from the development token every time it sees it (a connection, a request): a role changed only in the
 * database is put back at the next one. So that a lowered role lasts, the open page's own token is swapped for one that says the same.
 */
const holdRole = (page: import('@playwright/test').Page, userId: string, role: 'member' | 'viewer'): Promise<void> =>
  page.evaluate(([key, value]) => window.localStorage.setItem(key as string, value as string), [DEV_TOKEN_STORAGE_KEY, buildDevToken(devSecret(), userId, role)]);

test.describe('an administrator changes access under an open page', () => {
  // The app is recreated once for the four specifications, not twice for each: a recreation (a container started and waited for) takes as long as the host is slow, and counted
  // against the time of a specification it made one of them time out on a slow runner while the behaviour under test was fine. The settings are the re-check every two seconds.
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    await recreateApp({ M6_RECHECK_SECONDS: '2' });
  });
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await recreateApp(); // the stack's defaults again, for the specifications that follow
  });

  test('access taken away: every denial of a page looks the same, so the page shows "Page not found" and the server refuses the person with not-found', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('# Closed\n\nA page that is closed to its reader.\n');
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
  });

  test('a person who is suspended: the account is signed out ("Your account is suspended"), and the server refuses their sockets with forbidden', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('# Suspended\n\nA page open in the tab of a person who is then suspended.\n');
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
  });

  test('write access taken down to read: the page goes read-only, keeps its text and does not offer a copy, and the page is not reset', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('# Lowered\n\nA page whose editor is lowered to a reader.\n');
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
      // The settle point is the server's next look at this connection: the permission is given back, and when the editor is editable again the server has re-checked it
      // once more since the downgrade. A reset that was going to follow the downgrade has shown by then.
      await setDefaultPermission(made.collectionId, 'read_write');
      await expect(surface).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect(page.getByText('This page was reset. Your unsent changes were not applied.')).toHaveCount(0);
      expect((await readPage(made.id)).stateEpoch, 'no reset: the epoch is the same').toBe(before.stateEpoch);
    } finally {
      await users.close();
    }
  });

  test('a role lowered from member to viewer: the page goes read-only, keeps its text, and is not reset; the role is restored afterwards', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('# Viewer\n\nA page open in the tab of a person whose role is lowered.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const bob = await whoIs(users.b.userId);
      try {
        const { page } = users.b;
        await page.goto(made.path);
        await waitForSynced(page);
        const surface = page.locator('.ProseMirror');
        await expect(surface).toHaveAttribute('contenteditable', 'true');
        const before = await readPage(made.id);
        await holdRole(page, users.b.userId, 'viewer'); // what the page presents from now on says viewer, so the server's sync of the role from the token keeps it
        await setRole(bob.id, 'viewer');
        await expect(surface).toHaveAttribute('contenteditable', 'false', { timeout: 30_000 });
        await expect(page.getByText('Read only')).toBeVisible();
        await expect(surface).toContainText('A page open in the tab of a person whose role is lowered.');
        // The settle point is the server's next look at this connection: the role is given back, and when the editor is editable again the server has re-checked it once more
        // since the downgrade. A reset that was going to follow the downgrade has shown by then.
        await holdRole(page, users.b.userId, 'member');
        await setRole(bob.id, 'member');
        await expect(surface).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
        await expect(page.getByText('This page was reset. Your unsent changes were not applied.')).toHaveCount(0);
        expect((await readPage(made.id)).stateEpoch, 'no reset: the epoch is the same').toBe(before.stateEpoch);
      } finally {
        await setRole(bob.id, 'member'); // the other specs sign in as this person, as a member (their token says so too, so it would be put back at their next request anyway)
      }
    } finally {
      await users.close();
    }
  });
});
