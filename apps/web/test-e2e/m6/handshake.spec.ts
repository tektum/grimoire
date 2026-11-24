import { expect, test } from '@playwright/test';
import { buildDevToken } from '../../test/support/dev-token';
import { mapSignal } from '../../src/editor/core/map-signal';
import { makePage } from '../editor/pages';
import { probe } from '../editor/probe';
import { apiUrl, devSecret } from '../support/env';
import { signInAs } from '../support/sign-in';
import { handshakeProblem } from './handshake-check';

// The exit test runs against a server that requires the handshake (`make test-m6` starts it so: M6_REQUIRE_HANDSHAKE=1), so that the wrapper of the connection is proved in every
// browser: the page opens and syncs (the other specifications of the run do), and a token that is not a handshake is refused.
test('the server of the run requires the handshake: a bare token is refused as coming from a client that is too old', async ({ browser, baseURL }) => {
  test.skip(process.env['M6_EXIT'] !== '1', 'only in the exit test (make test-m6 sets M6_EXIT=1): the other runs of the browser specifications do not start a server that requires the handshake');
  expect(handshakeProblem(process.env), 'the server of the run').toBeNull();
  const made = await makePage('# Required\n\nA page on a server that requires the handshake.\n');
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(context, 'e2e-bare-exit', 'member');
    const page = await context.newPage();
    await page.goto('/');
    const config = (await (await fetch(`${apiUrl()}/v1/config`)).json()) as { collabUrl: string };
    const seen = await probe(page, { collabUrl: config.collabUrl, documentName: made.id, handshake: buildDevToken(devSecret(), 'e2e-bare-exit', 'member') });
    expect(seen.denied, 'the server says the client is too old: it received no handshake').toBe('client-too-old');
    expect(seen.close, 'and the socket is closed').not.toBeNull();
    expect(mapSignal({ type: 'close', code: seen.close!.code, reason: seen.close!.reason })).toEqual(mapSignal({ type: 'authenticationFailed', reason: 'client-too-old' }));
  } finally {
    await context.close();
  }
});
