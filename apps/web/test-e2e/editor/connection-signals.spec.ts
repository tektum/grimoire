import { randomUUID } from 'node:crypto';
import { buildDevToken } from '../../test/support/dev-token';
import { expect, test } from '@playwright/test';
import { mapSignal } from '../../src/editor/core/map-signal';
import { apiUrl, devSecret } from '../support/env';
import { signInAs } from '../support/sign-in';
import { makePage } from './pages';

/**
 * The probe: connects to the real collaboration server with a socket of its own, from a page of the app (so the server sees the app's origin), and
 * records what the server says for each refusal: the permission-denied reason, then the close code and reason. The rows the web client acts on are
 * checked against `mapSignal`, so a server that says something the table does not know fails here.
 */
interface Observed {
  readonly denied: string | null;
  readonly close: { readonly code: number; readonly reason: string } | null;
}

async function probe(page: import('@playwright/test').Page, options: { collabUrl: string; documentName: string; handshake: string }): Promise<Observed> {
  return page.evaluate(async ({ collabUrl, documentName, handshake }) => {
    const uint = (out: number[], value: number) => {
      let n = value;
      while (n > 127) {
        out.push(128 | (n & 127));
        n = Math.floor(n / 128);
      }
      out.push(n);
    };
    const string = (out: number[], text: string) => {
      const data = new TextEncoder().encode(text);
      uint(out, data.length);
      out.push(...data);
    };
    const auth: number[] = [];
    string(auth, documentName);
    uint(auth, 2); // authentication
    uint(auth, 0); // a token
    string(auth, handshake);
    const readUint = (bytes: Uint8Array, at: { i: number }) => {
      let result = 0;
      let shift = 1;
      for (;;) {
        const byte = bytes[at.i++]!;
        result += (byte & 127) * shift;
        if (byte < 128) return result;
        shift *= 128;
      }
    };
    const readString = (bytes: Uint8Array, at: { i: number }) => {
      const length = readUint(bytes, at);
      const text = new TextDecoder().decode(bytes.slice(at.i, at.i + length));
      at.i += length;
      return text;
    };
    return await new Promise<{ denied: string | null; close: { code: number; reason: string } | null }>((resolve) => {
      const seen: { denied: string | null; close: { code: number; reason: string } | null } = { denied: null, close: null };
      const socket = new WebSocket(collabUrl);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(new Uint8Array(auth));
      socket.onmessage = (event) => {
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        const at = { i: 0 };
        readString(bytes, at);
        if (readUint(bytes, at) === 2 && readUint(bytes, at) === 1) seen.denied = readString(bytes, at); // permission denied, with its reason
      };
      socket.onclose = (event) => {
        seen.close = { code: event.code, reason: event.reason };
        resolve(seen); // the server closes the socket after a refusal: that ends the probe
      };
    });
  }, options);
}

const token = (session: string, extra: Record<string, unknown> = {}) => `g1.${Buffer.from(JSON.stringify({ t: session, v: '0.0.0', ...extra })).toString('base64url')}`;

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
