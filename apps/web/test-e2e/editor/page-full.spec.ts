import { expect, test } from '@playwright/test';
import { buildDevToken } from '../../test/support/dev-token';
import { mapSignal } from '../../src/editor/core/map-signal';
import { apiUrl, devSecret } from '../support/env';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from './pages';
import { probe, token } from './probe';
import { recreateApp } from './stack';

test.describe('a page that already has as many connections as the server allows', () => {
  // The stack's defaults come back here, with a time of their own, and not in the test: a restore inside the test is cut by the test's own timeout, and the specs after it (two or three people on one
  // page) would then run against an app that allows one connection a page and wait for a second seat that never comes (a slow first recreate once cost three specs and about seven minutes that way).
  test.afterAll(async () => {
    test.setTimeout(300_000);
    await recreateApp();
  });

  test('the next connection is refused with a reason the client has a busy row for', async ({ browser, baseURL }) => {
    test.slow(); // the app is recreated here, and again in afterAll
    const made = await makePage('# Full\n\nA page with one seat.\n');
    await recreateApp({ M6_MAX_CONNECTIONS_PER_PAGE: '1' });
    const users = await twoUsers(browser, baseURL);
    try {
      await users.a.page.goto(made.path);
      await waitForSynced(users.a.page); // the one seat is taken

      const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
      try {
        await signInAs(context, 'e2e-second', 'member');
        const second = await context.newPage();
        await second.goto('/');
        const config = (await (await fetch(`${apiUrl()}/v1/config`)).json()) as { collabUrl: string };
        const seen = await probe(second, { collabUrl: config.collabUrl, documentName: made.id, handshake: token(buildDevToken(devSecret(), 'e2e-second', 'member')) });
        console.log(`page-full observed ${JSON.stringify(seen)}`);
        expect(seen.denied, 'the reason of the refusal').toBe('page-full');
        expect(mapSignal({ type: 'authenticationFailed', reason: seen.denied! })).toMatchObject({ behaviour: 'BUSY' });
        expect(seen.close, 'the socket is closed after the refusal').not.toBeNull();
        expect(seen.close!.reason, 'the close repeats the refusal reason').toBe('page-full');
        expect(mapSignal({ type: 'close', code: seen.close!.code, reason: seen.close!.reason }), 'the close is handled as the refusal is').toEqual(mapSignal({ type: 'authenticationFailed', reason: 'page-full' }));
      } finally {
        await context.close();
      }
    } finally {
      await users.close();
    }
  });
});
