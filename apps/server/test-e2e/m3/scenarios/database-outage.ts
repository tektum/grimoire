import { closeDb, createUser, firstClose, freshSub, newPage, scalar, scenario, signedIn, startService, stopService, tokenFor, waitStack } from '../support.ts';
import { eventually } from '../support.ts';

// A database outage (the PostgreSQL container stopped): nobody is closed at once. A session whose token expires is still closed `session-expired` on time, because expiry never
// waits for the database. A session with a valid token is closed `try-again` only after the configured number of failed re-check rounds: max(3, ceil(120 / interval))
// = 24 rounds at the overlay's 5 s, so about 120 s. Result fields: expiredWhileDownMs, tryAgainMs (from the database stop).
await scenario('database-outage', 360_000, async (t) => {
  t.onDone(closeDb);
  await waitStack();
  const steady = freshSub('dbs'); const brief = freshSub('dbb');
  await createUser({ sub: steady }); await createUser({ sub: brief });
  const page = await newPage();
  const open: { destroy(): void }[] = [];
  t.onDone(() => { open.forEach((p) => { p.destroy(); }); });
  const TTL = 25;
  const a = await signedIn(page, 'valid session', await tokenFor({ sub: steady }), 'read-write'); open.push(a);
  const b = await signedIn(page, 'session that expires', await tokenFor({ sub: brief, ttlSeconds: TTL }), 'read-write'); open.push(b);
  const expiresAt = Date.now() + TTL * 1000;

  t.onDone(async () => { await startService('postgres'); await eventually(async () => { try { return (await scalar('select 1')) === '1' ? true : undefined; } catch { return undefined; } }, 90_000, 'the database to answer again'); });
  const stoppedAt = Date.now();
  await stopService('postgres');

  const e = await firstClose(b, 90_000, 'the expiring session to be closed while the database is down');
  t.equal(e.reason, 'session-expired', 'with the database down a session is still closed session-expired at its expiry');
  t.metric('expiredWhileDownMs', Date.now() - stoppedAt);
  t.check(Date.now() - expiresAt < 15_000, 'the expiry did not wait for the database');
  t.check(a.closed.length === 0 && a.provider.isAuthenticated, 'the session with a valid token is still open when the other one expires');

  const c = await firstClose(a, 240_000, 'the valid session to be closed after the failed rounds');
  const tryAgainMs = Date.now() - stoppedAt;
  t.metric('tryAgainMs', tryAgainMs);
  t.equal(c.reason, 'try-again', 'after the failed rounds the valid session is closed try-again');
  t.check(tryAgainMs >= 90_000 && tryAgainMs < 200_000, `closed after the configured number of failed rounds, not at once (${String(tryAgainMs)} ms)`);
});
