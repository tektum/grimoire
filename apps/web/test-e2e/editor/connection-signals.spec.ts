import { randomUUID } from 'node:crypto';
import { buildDevToken } from '../../test/support/dev-token';
import { expect, test } from '@playwright/test';
import { mapSignal } from '../../src/editor/core/map-signal';
import { apiUrl, devSecret } from '../support/env';
import { signInAs } from '../support/sign-in';
import { makePage } from './pages';
import { probe, token } from './probe';

test.describe('connection signals of the real server', () => {
  test('a token the server does not accept, a page that does not exist and a name that is not a page are each refused with a reason the client has a row for', async ({ browser, baseURL }) => {
    const made = await makePage('# Probe\n');
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-probe', 'member');
      const page = await context.newPage();
      await page.goto('/');
      const config = (await (await fetch(`${apiUrl()}/v1/config`)).json()) as { collabUrl: string };
      const good = buildDevToken(devSecret(), 'e2e-probe', 'member');

      const observed = {
        'invalid-token': await probe(page, { collabUrl: config.collabUrl, documentName: made.id, handshake: token('not-a-session-token') }),
        'not-found': await probe(page, { collabUrl: config.collabUrl, documentName: randomUUID(), handshake: token(good) }),
        'bad-document-name': await probe(page, { collabUrl: config.collabUrl, documentName: 'not-a-page-id', handshake: token(good) }),
      };
      console.log(`observed-signals ${JSON.stringify(observed)}`); // in the job log of a passing run too: the attachment is only kept for a failing one
      await test.info().attach('observed-signals.json', { body: JSON.stringify(observed, null, 2), contentType: 'application/json' });

      for (const [expected, seen] of Object.entries(observed)) {
        expect(seen.denied, `${expected}: the reason of the refusal`).toBe(expected);
        const mapping = mapSignal({ type: 'authenticationFailed', reason: seen.denied! });
        expect(mapping.behaviour, `${expected}: the client has a row for it`).not.toBe('IGNORE');
        // The close that follows says the same: a close carrying the refusal's reason, whose code the client maps to the same row as the refusal.
        expect(seen.close, `${expected}: the socket is closed after the refusal`).not.toBeNull();
        expect(seen.close!.reason, `${expected}: the reason of the close`).toBe(expected);
        expect(mapSignal({ type: 'close', code: seen.close!.code, reason: seen.close!.reason }), `${expected}: the close and the refusal are handled alike`).toEqual(mapping);
      }
    } finally {
      await context.close();
    }
  });
});
