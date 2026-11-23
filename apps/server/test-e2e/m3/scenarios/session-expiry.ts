import type { Peer } from '../support.ts';
import { closeDb, createUser, firstClose, freshSub, holds, newPage, scenario, signedIn, tokenFor, waitStack } from '../support.ts';

// Token expiry and renewal (re-check interval 5 s). With no fresh token a session is closed `session-expired` (4401) within a few seconds of its expiry; a fresh token for the
// same user presented on the open connection (the client answers the server's token request) keeps it; a token that does not verify, or is another person's, closes it `invalid-token`.
// Result field: expiryLagMs (from the token's expiry to the client seeing the close).
await scenario('session-expiry', 180_000, async (t) => {
  t.onDone(closeDb);
  await waitStack();
  const subs = { expiring: freshSub('xe'), renewed: freshSub('xr'), forged: freshSub('xf'), other: freshSub('xo'), theirs: freshSub('xt') };
  for (const sub of Object.values(subs)) await createUser({ sub });
  const page = await newPage();
  const open: { destroy(): void }[] = [];
  t.onDone(() => { open.forEach((p) => { p.destroy(); }); });
  const TTL = 14;
  const short = async (sub: string): Promise<{ token: string; expiresAtMs: number }> => ({ token: await tokenFor({ sub, ttlSeconds: TTL }), expiresAtMs: Date.now() + TTL * 1000 });

  // Every client signs in with a short token, so that the server (which asks for a fresh token only near expiry) asks within seconds.
  const e = await short(subs.expiring);
  const expiring = await signedIn(page, 'expiring', e.token, 'read-write'); open.push(expiring);
  let renewal = (await short(subs.renewed)).token;
  const renewed = await signedIn(page, 'renewed', () => renewal, 'read-write'); open.push(renewed);
  let forgedNext = (await short(subs.forged)).token;
  const forged = await signedIn(page, 'forged renewal', () => forgedNext, 'read-write'); open.push(forged);
  let swapNext = (await short(subs.other)).token;
  const swapped = await signedIn(page, 'renewal for another person', () => swapNext, 'read-write'); open.push(swapped);
  // From here the clients answer the server's token request with: a fresh token (renewed), a token signed by another key, a valid token of another person.
  renewal = await tokenFor({ sub: subs.renewed });
  forgedNext = await tokenFor({ sub: subs.forged, variant: 'other-key' });
  swapNext = await tokenFor({ sub: subs.theirs });

  const f = await closeOf(forged, 'the forged renewal');
  t.equal(f.reason, 'invalid-token', 'a renewal token signed by another key closes the session invalid-token');
  t.equal(f.code, 4401, 'invalid-token closes with 4401');
  const x = await closeOf(swapped, 'the renewal for another person');
  t.equal(x.reason, 'invalid-token', 'a valid token of ANOTHER person closes the session invalid-token');

  const c = await firstClose(expiring, 60_000, 'the expiring session to be closed');
  t.equal(c.reason, 'session-expired', 'a session with no fresh token is closed session-expired');
  t.equal(c.code, 4401, 'session-expired closes with 4401');
  const lag = Date.now() - e.expiresAtMs;
  t.metric('expiryLagMs', lag);
  t.check(lag < 12_000, `the close came within two intervals of the expiry (${String(lag)} ms)`);
  await holds(2000, () => renewed.closed.length === 0 && renewed.provider.isAuthenticated, 'the renewed session stays open past the first expiry');
  t.check(Date.now() > e.expiresAtMs, 'the renewed session outlived the first token\'s expiry');

  async function closeOf(p: Peer, what: string): Promise<{ readonly code: number; readonly reason: string }> { return firstClose(p, 60_000, `${what}: the session to be closed`); }
});
