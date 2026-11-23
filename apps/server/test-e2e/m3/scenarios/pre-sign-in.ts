import { closeDb, createUser, eventually, freshSub, newPage, rawSocket, scenario, signedIn, tokenFor, waitStack } from '../support.ts';
import type { RawSocket } from '../support.ts';

// The window before sign-in: a socket that is upgraded but never signs in. Per address at most 10 such sockets are held (the 11th upgrade is refused 429 with Retry-After 2);
// each one is closed 4408 `preauth-timeout` after the pre-sign-in timeout (5 s); the places are then free and a person can sign in at once.
await scenario('pre-sign-in', 120_000, async (t) => {
  t.onDone(closeDb);
  await waitStack();
  const sub = freshSub('pre');
  await createUser({ sub });
  const page = await newPage();
  const sockets: RawSocket[] = [];
  t.onDone(() => { sockets.forEach((s) => { s.destroy(); }); });
  const startedAt = Date.now();
  for (let i = 0; i < 10; i++) {
    const s = await rawSocket(); sockets.push(s);
    t.equal(s.status, 101, `idle socket ${String(i + 1)} of 10 is upgraded`);
  }
  const eleventh = await rawSocket(); sockets.push(eleventh);
  t.equal(eleventh.status, 429, 'the 11th not-yet-signed-in socket of one address is refused 429');
  t.equal(eleventh.retryAfter, '2', 'with Retry-After 2');
  const closes = await Promise.all(sockets.slice(0, 10).map((s) => s.closing));
  const waitedMs = Date.now() - startedAt;
  t.metric('preSignInCloseMs', waitedMs);
  for (const c of closes) t.equal(c, { code: 4408, reason: 'preauth-timeout' }, 'an idle socket is closed 4408 preauth-timeout');
  t.check(waitedMs >= 4000 && waitedMs < 9000, `the timeout is the configured 5 s (${String(waitedMs)} ms)`);
  // The places are free again.
  const p = await eventually(async () => { try { return await signedIn(page, 'after the window', await tokenFor({ sub }), 'read-write'); } catch { return undefined; } }, 20_000, 'a person to sign in once the idle sockets are gone');
  t.check(p.provider.isAuthenticated, 'a person signs in once the idle sockets are gone');
  p.destroy();
});
