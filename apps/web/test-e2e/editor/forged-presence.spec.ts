import { buildDevToken } from '../../test/support/dev-token';
import { expect, test } from '@playwright/test';
import { COLLAB_COLOURS, colourIndex } from '../../src/ui/collab';
import { apiUrl, devSecret } from '../support/env';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from './pages';

/**
 * Publishes `user: { id, name: 'Forged', color: '#ff0000' }` through a hand-built awareness frame on a socket of its own, the way a client that is not this one
 * would. It runs in a page of the app (so the server sees the app's origin), and builds the frames byte by byte: the message layout of the collaboration protocol.
 */
async function publishForged(page: import('@playwright/test').Page, options: { collabUrl: string; documentName: string; token: string; id: string }): Promise<void> {
  await page.evaluate(async ({ collabUrl, documentName, token, id }) => {
    const bytes = (out: number[], text: string) => {
      const data = new TextEncoder().encode(text);
      uint(out, data.length);
      out.push(...data);
    };
    const uint = (out: number[], value: number) => {
      let n = value;
      while (n > 127) {
        out.push(128 | (n & 127));
        n = Math.floor(n / 128);
      }
      out.push(n);
    };
    const handshake = `g1.${btoa(JSON.stringify({ t: token, v: '0.0.0' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`;
    const auth: number[] = [];
    bytes(auth, documentName);
    uint(auth, 2); // an authentication message
    uint(auth, 0); // carrying a token
    bytes(auth, handshake);
    const update: number[] = [];
    uint(update, 1); // one client
    uint(update, 4_000_000_000); // a client id of its own
    uint(update, 1); // clock
    bytes(update, JSON.stringify({ user: { id, name: 'Forged', color: '#ff0000' } }));
    const frame: number[] = [];
    bytes(frame, documentName);
    uint(frame, 1); // an awareness message
    uint(frame, update.length);
    frame.push(...update);
    // A second socket that only listens: the server sends it every awareness update of the page, so it sees the forged frame come back.
    const contains = (data: ArrayBuffer, needle: number[]) => {
      const view = new Uint8Array(data);
      for (let i = 0; i + needle.length <= view.length; i++) if (needle.every((byte, k) => view[i + k] === byte)) return true;
      return false;
    };
    const clientBytes: number[] = [];
    uint(clientBytes, 4_000_000_000);
    const listener = new WebSocket(collabUrl);
    listener.binaryType = 'arraybuffer';
    const relayed = new Promise<void>((resolve) => {
      listener.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer && contains(event.data, clientBytes)) resolve();
      };
    });
    await new Promise<void>((resolve, reject) => {
      listener.onerror = () => reject(new Error('the listening socket failed'));
      listener.onopen = () => {
        listener.send(new Uint8Array(auth));
        resolve();
      };
    });
    const socket = new WebSocket(collabUrl);
    socket.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      socket.onerror = () => reject(new Error('the collaboration socket failed'));
      socket.onopen = () => socket.send(new Uint8Array(auth));
      socket.onmessage = () => {
        socket.onmessage = null;
        socket.send(new Uint8Array(frame)); // after the answer to the authentication
        resolve();
      };
    });
    await relayed; // the server has taken the frame and sent it on to everyone on the page
    (window as unknown as { forgedSocket: WebSocket }).forgedSocket = socket; // stays open for the rest of the test
  }, options);
}

test.describe('forged presence', () => {
  test('a name and a colour published by another client are never shown: the cursor label reads the directory name in the derived colour, and "Forged" is nowhere in the page', async ({
    browser,
    baseURL,
  }) => {
    const made = await makePage('# Presence\n\nSomeone writes here.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const config = (await (await fetch(`${apiUrl()}/v1/config`)).json()) as { collabUrl: string };
      const meB = (await (await fetch(`${apiUrl()}/v1/me`, { headers: { Authorization: `Bearer ${buildDevToken(devSecret(), users.b.userId, 'member')}` } })).json()) as { id: string; name: string };

      // B has the page open and a real cursor in it.
      await users.a.page.goto(made.path);
      await users.b.page.goto(made.path);
      await waitForSynced(users.a.page);
      await waitForSynced(users.b.page);
      await users.b.page.locator('.ProseMirror p', { hasText: 'Someone writes here.' }).click();
      const label = users.a.page.locator('.ProseMirror-yjs-cursor .cursor-label');
      await expect(label).toHaveText(meB.name);

      // A third socket of B's, in a page that is not editing, publishes the forged name and colour.
      const forger = await users.b.context.newPage();
      await forger.goto('/');
      await publishForged(forger, { collabUrl: config.collabUrl, documentName: made.id, token: buildDevToken(devSecret(), users.b.userId, 'member'), id: meB.id });

      // The frame was relayed to everyone on the page before this point. A's socket delivers in order, so once A shows a change that B makes now,
      // the forged frame has reached A and been applied (or ignored) first: the checks below look at a page that has seen it.
      await users.b.page.locator('.ProseMirror p', { hasText: 'Someone writes here.' }).click();
      await users.b.page.keyboard.press('End');
      await users.b.page.keyboard.type(' Ping.');
      await expect(users.a.page.locator('.ProseMirror')).toContainText('Ping.');

      // A still reads the directory name, in the colour of the id; nothing of the forged frame is in the DOM.
      await expect(label).toHaveText(meB.name);
      const caret = users.a.page.locator('.ProseMirror-yjs-cursor');
      expect(await caret.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--cursor'))).toBe(COLLAB_COLOURS[colourIndex(meB.id)]);
      expect(await users.a.page.evaluate(() => document.documentElement.outerHTML.includes('Forged'))).toBe(false);
      expect(await users.a.page.evaluate(() => document.documentElement.outerHTML.toLowerCase().includes('#ff0000'))).toBe(false);
      await forger.close();
    } finally {
      await users.close();
    }
  });
});
