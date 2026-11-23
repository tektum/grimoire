import { closeDb, createCollection, createPageIn, createUser, eventually, freshSub, grant, holds, newPage, scenario, signedIn, storedText, tokenFor, waitStack } from '../support.ts';

// Read-only access through the real adapter, by three roads: a person with the viewer role in an open collection, a member of a collection whose default is `read`, and the same
// member with a `read_write` entry (granted at connect time, so it edits). A read-only client sees what the writers type; what it types reaches nobody and is never stored.
await scenario('read-only', 120_000, async (t) => {
  t.onDone(closeDb);
  await waitStack();
  const viewer = freshSub('rov'); const member = freshSub('rom'); const editor = freshSub('roe'); const writer = freshSub('row');
  await createUser({ sub: viewer, role: 'viewer' });
  for (const sub of [member, editor, writer]) await createUser({ sub });
  const open: { destroy(): void }[] = [];
  t.onDone(() => { open.forEach((p) => { p.destroy(); }); });

  // Road 1: viewer role in the open "Dev" collection.
  const devPage = await newPage();
  const w1 = await signedIn(devPage, 'dev writer', await tokenFor({ sub: writer }), 'read-write'); open.push(w1);
  const v = await signedIn(devPage, 'viewer', await tokenFor({ sub: viewer }), 'readonly'); open.push(v);
  t.metric('viewerScope', v.provider.authorizedScope);
  const m1 = `m3-ro-dev-${String(t.seed)}`;
  w1.text.insert(0, m1);
  await eventually(() => (v.text.toString() === m1 ? true : undefined), 15_000, 'the writer\'s edit to reach the viewer');
  v.text.insert(v.text.length, 'VIEWER-TYPED');
  await holds(3000, () => !w1.text.toString().includes('VIEWER-TYPED'), 'the viewer\'s edit must not reach the writer');
  const m1b = '-end';
  w1.text.insert(w1.text.length, m1b);
  t.equal(await eventually(async () => { const s = await storedText(devPage); return s.includes(m1b) ? s : undefined; }, 20_000, 'the writer\'s later edit to be stored'), m1 + m1b, 'the viewer\'s typing was never stored');

  // Road 2 and 3: a collection whose default is `read`; one member has only the default, one has an entry.
  const readable = await createCollection(`Readable ${String(t.seed)}`, 'read');
  const page = await createPageIn(readable);
  await grant(readable, editor, 'read_write');
  const w2 = await signedIn(page, 'entry holder', await tokenFor({ sub: editor }), 'read-write'); open.push(w2);
  const r = await signedIn(page, 'default reader', await tokenFor({ sub: member }), 'readonly'); open.push(r);
  t.metric('defaultReadScope', r.provider.authorizedScope);
  const m2 = `m3-ro-coll-${String(t.seed)}`;
  w2.text.insert(0, m2);
  await eventually(() => (r.text.toString() === m2 ? true : undefined), 15_000, 'the entry holder\'s edit to reach the default reader');
  r.text.insert(0, 'MEMBER-TYPED');
  await holds(3000, () => !w2.text.toString().includes('MEMBER-TYPED'), 'the default reader\'s edit must not reach the entry holder');
  const m2b = '-more';
  w2.text.insert(w2.text.length, m2b);
  t.equal(await eventually(async () => { const s = await storedText(page); return s.includes(m2b) ? s : undefined; }, 20_000, 'the entry holder\'s later edit to be stored'), m2 + m2b, 'the default reader\'s typing was never stored');
  t.check(w1.closed.length + v.closed.length + w2.closed.length + r.closed.length === 0, 'no client was closed');
});
