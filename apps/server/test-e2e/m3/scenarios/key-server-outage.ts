import { attempt, closeDb, createUser, eventually, freshSub, holds, newPage, scenario, signedIn, startService, stopService, storedText, tokenFor, waitStack } from '../support.ts';

// A key-server outage closes NOBODY: sessions that are open stay open and keep storing edits while the key server is down. When it is back it has a NEW key (a fresh key id at every
// start): a token of the new key signs in (within the SDK's 30 s unknown-key cooldown), and a token signed by the OLD key, which the key server no longer publishes, is refused
// `invalid-token`: a token whose key differs from the key server's. Result fields: recoveryMs (key server started to first new sign-in), outcomesWhileRecovering.
await scenario('key-server-outage', 300_000, async (t) => {
  t.onDone(closeDb);
  await waitStack();
  const sub = freshSub('kso'); const later = freshSub('ksl');
  await createUser({ sub }); await createUser({ sub: later });
  const page = await newPage();
  const open: { destroy(): void }[] = [];
  t.onDone(() => { open.forEach((p) => { p.destroy(); }); });
  const oldKeyToken = await tokenFor({ sub: later });
  const session = await signedIn(page, 'session before the outage', await tokenFor({ sub }), 'read-write'); open.push(session);
  const marker = `m3-ks-${String(t.seed)}`;
  session.text.insert(0, marker);
  await eventually(async () => ((await storedText(page)) === marker ? true : undefined), 20_000, 'the first edit to be stored');

  t.onDone(async () => { await startService('keyserver'); await waitStack(); });
  await stopService('keyserver');
  await holds(20_000, () => session.closed.length === 0 && session.provider.isAuthenticated, 'the session stays open through four re-check rounds with the key server down');
  const during = '-during-outage';
  session.text.insert(session.text.length, during);
  t.equal(await eventually(async () => { const s = await storedText(page); return s.includes(during) ? s : undefined; }, 20_000, 'an edit made during the outage to be stored'), marker + during, 'an edit made while the key server is down is stored');

  await startService('keyserver'); const restartedAt = Date.now();
  await waitStack();
  const outcomes = new Set<string>();
  const fresh = await eventually(async () => {
    const r = await attempt(page, 'new key', await tokenFor({ sub: later }));
    outcomes.add(r.outcome);
    if (r.outcome === 'read-write') { open.push(r.peer); return r.peer; }
    r.peer.destroy();
    return undefined;
  }, 90_000, 'a token of the new key to sign in');
  t.metric('recoveryMs', Date.now() - restartedAt);
  t.metric('outcomesWhileRecovering', [...outcomes]);
  t.check(fresh.provider.isAuthenticated, 'a token of the new key signs in after the key server is back');
  const stale = await eventually(async () => {
    const r = await attempt(page, 'old key', oldKeyToken);
    if (r.outcome === 'try-again') { r.peer.destroy(); return undefined; }
    open.push(r.peer);
    return r;
  }, 60_000, 'the old-key token to be answered other than try-again');
  t.equal(stale.outcome, 'invalid-token', 'a token signed by a key the key server no longer publishes is refused invalid-token');
  t.check(session.provider.isAuthenticated && session.closed.length === 0, 'the session of before the outage was never closed');
});
