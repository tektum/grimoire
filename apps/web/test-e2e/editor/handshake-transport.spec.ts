import { expect, test, type Page } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage, readPage } from './pages';
import { appEvents, compose, waitReady } from './stack';

interface Handshake {
  t: string;
  v?: string;
  e?: number;
}

/** The handshake tokens the page's own sockets send: the `g1.` text inside each frame the page writes, decoded. */
function recordHandshakes(page: Page): Handshake[] {
  const seen: Handshake[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      const text = typeof frame.payload === 'string' ? frame.payload : Buffer.from(frame.payload).toString('latin1');
      const match = /g1\.([A-Za-z0-9_-]+)/.exec(text);
      if (match?.[1] !== undefined) seen.push(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as Handshake);
    });
  });
  return seen;
}

const connected = async (since: Date): Promise<number> => (await appEvents(since)).filter((e) => e.event === 'collab.connected').length;

test.describe('the handshake on the wire', () => {
  test('the first connect and the reconnect after the app restarts each present a handshake token, and the reconnect carries the epoch recorded on the first', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('# Wire\n\nA page on the wire.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      const handshakes = recordHandshakes(page);
      const since = new Date();
      await page.goto(made.path);
      await waitForSynced(page);

      expect(handshakes).toHaveLength(1);
      expect(handshakes[0]!.e).toBeUndefined(); // a first connect has no epoch to send
      expect(handshakes[0]!.v).toBeTruthy();
      await expect.poll(() => connected(since), { timeout: 30_000 }).toBe(1);

      await compose('restart', 'app');
      await waitReady();
      await expect.poll(() => handshakes.length, { timeout: 120_000, message: 'the automatic reconnect' }).toBeGreaterThanOrEqual(2);
      await waitForSynced(page);

      const { stateEpoch } = await readPage(made.id);
      expect(handshakes.at(-1)!.e).toBe(stateEpoch); // the epoch recorded when the page first synced
      await expect.poll(() => connected(since), { timeout: 30_000 }).toBe(2);
      await expect(page.locator('.ProseMirror')).toHaveCount(1);
    } finally {
      await users.close();
    }
  });
});
