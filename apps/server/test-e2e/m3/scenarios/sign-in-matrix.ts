import { MUTATION, PROJECT_ID, attempt, closeDb, createUser, eventually, freshSub, newPage, scalar, scenario, setSuspended, storedText, tokenFor, userRows, waitStack } from '../support.ts';
import type { Variant } from '../support.ts';

// Through the real Descope adapter and the local key server: a good token for a known user with write access edits a page and the edit is stored; every defective
// token is refused `invalid-token` (as the committed connect-time tests assert: apps/server/test/collab/descope-host.int.test.ts); a good token for a person with
// no user row, or for a suspended user, is refused `forbidden`; nothing a refused client typed reaches the page, and no user row is created.
// M3_NO_FIXTURE=1 skips creating the fixed test user (the proof run that deletes its row first must then FAIL).
const WRITER = 'U2m3writer';
await scenario('sign-in-matrix', 120_000, async (t) => {
  t.onDone(closeDb);
  await waitStack();
  if (process.env['M3_NO_FIXTURE'] !== '1') await createUser({ sub: WRITER });
  const suspended = freshSub('susp');
  await createUser({ sub: suspended, suspended: true });
  t.equal(await scalar(`select count(*) from users where descope_user_id = '${suspended}' and suspended_at is not null`), '1', 'the suspended user exists with suspended_at set');
  if (MUTATION === 'unsuspend') await setSuspended(suspended, false); // proof run: the user is no longer suspended (set after the fixture, which would overwrite it)
  const stranger = freshSub('nobody');
  const page = await newPage();
  t.metric('projectId', PROJECT_ID); t.metric('page', page);
  const opened: { destroy(): void }[] = [];
  t.onDone(() => { opened.forEach((p) => { p.destroy(); }); });
  const refused = async (label: string, token: string, expected: string): Promise<void> => {
    const r = await attempt(page, label, token, `REFUSED-${label}`);
    opened.push(r.peer);
    t.equal(r.outcome, expected, `${label}: refused ${expected}`);
    t.check(!r.peer.provider.isAuthenticated, `${label}: the client never became authenticated`);
    r.peer.destroy();
  };

  const good = await attempt(page, 'good token', await tokenFor({ sub: WRITER }));
  opened.push(good.peer);
  t.equal(good.outcome, 'read-write', 'a good token for a known user with write access is granted read-write');
  const marker = `m3-signed-in-${String(t.seed)}`;
  good.peer.text.insert(0, marker);
  const stored = await eventually(async () => { const s = await storedText(page); return s.includes(marker) ? s : undefined; }, 20_000, 'the edit to be stored');
  t.equal(stored, marker, 'the stored row holds exactly the signed-in edit');
  for (const [variant, label] of [['expired', 'expired token'], ['wrong-issuer', 'wrong-issuer token'], ['refresh', 'refresh token (drn DSR)'], ['other-key', 'token signed by another key']] as [Variant, string][]) {
    await refused(label, await tokenFor({ sub: WRITER, variant }), 'invalid-token');
  }
  await refused('person with no user row', await tokenFor({ sub: stranger, claims: { email: `${stranger.toLowerCase()}@example.test`, name: 'Nobody' } }), 'forbidden');
  t.equal(await userRows(stranger), 0, 'no user row was created for the unknown person');
  await refused('suspended user', await tokenFor({ sub: suspended }), 'forbidden');

  // The refused clients typed before their handshake ended; a later edit of the good client is stored after any write they could have made, so the row must hold
  // exactly the two good edits.
  const marker2 = `-then-${String(t.seed)}`;
  good.peer.text.insert(good.peer.text.length, marker2);
  const final = await eventually(async () => { const s = await storedText(page); return s.includes(marker2) ? s : undefined; }, 20_000, 'the second edit to be stored');
  t.equal(final, marker + marker2, 'nothing was written to the page by any refused attempt');
  t.equal(await userRows(stranger), 0, 'still no row for the unknown person');
});
