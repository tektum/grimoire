import { devToken, eventually, newPage, peer, scenario, storedText, synced } from '../support.ts';

// A wrong token is refused; a right one supplied through the token function is accepted on the next connect; edits made meanwhile
// are unsynced, then synced and stored (R4.29, H item 1).
await scenario('auth-retry', 90_000, async (t) => {
  const page = await newPage();
  let token = 'dev:alice';
  const c = peer(page, 'alice', 'member', { token: () => token });
  t.onDone(() => { c.destroy(); });
  await eventually(() => (c.failures.length > 0 ? true : undefined), 10_000, 'the wrong token to be refused');
  t.equal(c.failures, ['invalid-token'], 'the wrong token is refused as invalid-token');
  c.text.insert(0, 'typed while refused');
  t.check(c.provider.hasUnsyncedChanges, 'an edit made while refused is unsynced');
  t.check(!c.provider.synced, 'the refused client is not synced');

  token = devToken('alice', 'member');
  // connect() is a no-op on an open socket: wait for the server to close the refused one.
  await eventually(() => (c.closes.length > 0 ? true : undefined), 10_000, 'the refused socket to be closed');
  await c.socket.connect();
  await synced(c, 15_000);
  t.check(c.provider.isAuthenticated, 'the right token, read through the function option, authenticates');
  await eventually(() => (!c.provider.hasUnsyncedChanges ? true : undefined), 15_000, 'the change to be synced');
  t.check(true, 'hasUnsyncedChanges becomes false after authentication');
  await eventually(async () => ((await storedText(page)) === 'typed while refused' ? true : undefined), 20_000, 'text stored');
  t.check(true, 'the text typed while refused is stored');
});
