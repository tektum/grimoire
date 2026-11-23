import { attempt, closeDb, createCollection, createPageIn, createUser, eventually, firstClose, freshSub, grant, holds, scenario, signedIn, storedText, tokenFor, waitStack } from '../support.ts';

// A CLOSED collection (no default permission) through the real Descope adapter: a person with no entry is refused `not-found` (close 4404, the page is not even said to exist),
// a person with a `read` entry is granted the read-only scope and sees the writer's edits, and what the reader types never reaches the writer or the stored page.
// Result fields: closedRefusal (the reason the stranger saw), closedScope (the scope the reader was granted).
await scenario('closed-collection', 120_000, async (t) => {
  t.onDone(closeDb);
  await waitStack();
  const writer = freshSub('cw'); const reader = freshSub('cr'); const stranger = freshSub('cs');
  for (const sub of [writer, reader, stranger]) await createUser({ sub });
  const collection = await createCollection(`Closed ${String(t.seed)}`, null);
  const page = await createPageIn(collection);
  await grant(collection, writer, 'read_write');
  await grant(collection, reader, 'read');
  const peers: { destroy(): void }[] = [];
  t.onDone(() => { peers.forEach((p) => { p.destroy(); }); });

  // No entry: refused not-found, closed 4404, never authenticated, and nothing it typed is stored.
  const refused = await attempt(page, 'person with no entry', await tokenFor({ sub: stranger }), 'STRANGER-TYPED');
  peers.push(refused.peer);
  t.equal(refused.outcome, 'not-found', 'a person with no entry to a closed collection is refused not-found');
  t.equal((await firstClose(refused.peer, 10_000, 'the refused client to see its close')).code, 4404, 'the refusal closes with 4404');
  t.check(!refused.peer.provider.isAuthenticated, 'the refused client was never told it is authenticated');
  t.metric('closedRefusal', refused.outcome);

  const w = await signedIn(page, 'writer', await tokenFor({ sub: writer }), 'read-write'); peers.push(w);
  const r = await signedIn(page, 'reader', await tokenFor({ sub: reader }), 'readonly'); peers.push(r);
  t.metric('closedScope', r.provider.authorizedScope);

  const first = `m3-closed-${String(t.seed)}`;
  w.text.insert(0, first);
  await eventually(() => (r.text.toString() === first ? true : undefined), 15_000, 'the writer\'s edit to reach the reader');
  t.equal(r.text.toString(), first, 'the reader sees the writer\'s edit');

  r.text.insert(r.text.length, 'READER-TYPED');
  await holds(3000, () => !w.text.toString().includes('READER-TYPED'), 'the reader\'s edit must not reach the writer');
  const second = `-then-${String(t.seed)}`;
  w.text.insert(w.text.length, second);
  const stored = await eventually(async () => { const s = await storedText(page); return s.includes(second) ? s : undefined; }, 20_000, 'the writer\'s second edit to be stored');
  t.equal(stored, first + second, 'the stored page holds exactly the writer\'s edits: nothing from the stranger or the reader');
  t.equal(w.text.toString(), first + second, 'the writer\'s text holds only its own edits');
  t.check(r.closed.length === 0 && w.closed.length === 0, 'neither signed-in client was closed');
});
