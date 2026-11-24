import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../../src/editor/core/connection';
import { TOKEN_WAIT_MS } from '../../src/editor/core/handshake-token';
import { decodeHandshake, flush, harness } from '../editor/support';

/** The server's window for a socket that has not authenticated (`GRIMOIRE_COLLAB_PREAUTH_TIMEOUT_SECONDS`, default 5). */
const SERVER_WINDOW_MS = 5000;
/** How long the slow token fetch takes, on the fake clock. */
const SLOW_FETCH_MS = 6000;

describe('the pre-sign-in window', () => {
  it('a token fetch that takes 6 s does not leave a socket open unauthenticated for more than 5 s, and the next attempt succeeds', async () => {
    const h = harness();
    let slow = true;
    h.auth.getToken = () => (slow ? new Promise((resolve) => void h.clock.after(() => resolve('late-token'), SLOW_FETCH_MS)) : Promise.resolve('fresh-token'));
    const manager = new ConnectionManager(h.options);
    const openedAt = h.clock.now();
    manager.start(); // the socket is open from here: the provider asks the token function
    await flush();
    const p = h.last().provider;
    await h.clock.advance(TOKEN_WAIT_MS);
    // The token function gave up at 2 s: the provider got a failure to act on, not a token 6 s later.
    expect(p.failures).toHaveLength(1);
    expect(h.clock.now() - openedAt).toBeLessThanOrEqual(SERVER_WINDOW_MS);
    expect(manager.state().text).toBe('Sign-in is unavailable. Trying again.');
    await h.clock.advance(4000); // the late answer arrives meanwhile: nothing is sent with it
    expect(p.tokens).toEqual([]);
    slow = false;
    await h.clock.advance(1000 + TOKEN_WAIT_MS); // the manager tries the token again 5 s after the failure
    await flush();
    expect(p.connects).toBe(2);
    expect(p.tokens).toHaveLength(1);
    expect(decodeHandshake(p.tokens[0]!).t).toBe('fresh-token');
  });

  it('hands out a cached session token at once, with no wait', async () => {
    const h = harness();
    const manager = new ConnectionManager(h.options);
    manager.start();
    await flush();
    expect(h.last().provider.tokens).toHaveLength(1);
    expect(h.clock.pendingCount()).toBe(0);
    expect(h.last().provider.failures).toEqual([]);
  });

  it("the wait is shorter than the server's window, with room for the socket to open and the message to travel", () => {
    expect(TOKEN_WAIT_MS).toBeLessThan(SERVER_WINDOW_MS);
    expect(SERVER_WINDOW_MS - TOKEN_WAIT_MS).toBeGreaterThanOrEqual(2000);
  });
});
