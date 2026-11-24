import { expect, test } from '@playwright/test';
import { buildDevToken } from '../../test/support/dev-token';
import { mapSignal } from '../../src/editor/core/map-signal';
import { apiUrl, devSecret } from '../support/env';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { recordHandshakes } from './handshakes';
import { makePage } from './pages';
import { probe } from './probe';
import { recreateApp } from './stack';

test.describe('a server that requires the handshake', () => {
  test('the page opens and syncs, every token the page sends is a handshake token, and a bare token is refused', async ({ browser, baseURL }) => {
    test.slow(); // the app is recreated twice
    const made = await makePage('# Required\n\nA page on a server that requires the handshake.\n');
    await recreateApp({ M6_REQUIRE_HANDSHAKE: '1' });
    try {
      const users = await twoUsers(browser, baseURL);
      try {
        const { page } = users.a;
        const handshakes = recordHandshakes(page);
        await page.goto(made.path);
        await waitForSynced(page);
        expect(handshakes.length).toBeGreaterThanOrEqual(1);
        for (const handshake of handshakes) expect(handshake.t, 'the session token inside the handshake').toMatch(/^dev:/);

        // A token that is not a handshake token (the session token alone) is refused, with a reason the client has a row for.
        const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
        try {
          await signInAs(context, 'e2e-bare', 'member');
          const bare = await context.newPage();
          await bare.goto('/');
          const config = (await (await fetch(`${apiUrl()}/v1/config`)).json()) as { collabUrl: string };
          const seen = await probe(bare, { collabUrl: config.collabUrl, documentName: made.id, handshake: buildDevToken(devSecret(), 'e2e-bare', 'member') });
          expect(seen.denied, 'the bare token is refused as coming from a client that is too old (one that sends no handshake)').toBe('client-too-old');
          expect(seen.close, 'and the socket is closed').not.toBeNull();
          expect(seen.close!.reason, 'the close repeats the refusal reason').toBe('client-too-old');
          expect(mapSignal({ type: 'close', code: seen.close!.code, reason: seen.close!.reason }), 'the close is handled as the refusal is').toEqual(
            mapSignal({ type: 'authenticationFailed', reason: 'client-too-old' }),
          );
          expect(mapSignal({ type: 'authenticationFailed', reason: seen.denied! }).behaviour).not.toBe('IGNORE');
          console.log(`require-handshake observed ${JSON.stringify(seen)}`);
        } finally {
          await context.close();
        }
      } finally {
        await users.close();
      }
    } finally {
      await recreateApp();
    }
  });
});
