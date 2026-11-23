import { attempt, closeDb, createUser, eventually, freshSub, firstClose, holds, newPage, openDoc, scenario, sharedSocket, signedIn, storedText, tokenFor, waitStack } from '../support.ts';
import type { Doc, Peer } from '../support.ts';

// The per-user caps (the overlay sets 3 sockets and 4 documents per user): the LATER arrival is refused `full-for-you` (close 4503) and is never told it is authenticated;
// the earlier sessions stay open and keep editing; another person is not affected; a freed place is usable again.
await scenario('user-caps', 180_000, async (t) => {
  t.onDone(closeDb);
  await waitStack();
  const heavy = freshSub('caph'); const other = freshSub('capo'); const docs = freshSub('capd');
  for (const sub of [heavy, other, docs]) await createUser({ sub });
  const page = await newPage();
  const open: { destroy(): void }[] = [];
  t.onDone(() => { open.forEach((p) => { p.destroy(); }); });

  // Sockets: three sockets of one person are admitted; the fourth is the later arrival and is refused.
  const held: Peer[] = [];
  for (const n of [1, 2, 3]) { const p = await signedIn(page, `socket ${String(n)}`, await tokenFor({ sub: heavy }), 'read-write'); held.push(p); open.push(p); }
  const late = await attempt(page, 'fourth socket', await tokenFor({ sub: heavy }), 'LATE-ARRIVAL');
  open.push(late.peer);
  t.equal(late.outcome, 'full-for-you', 'the fourth socket of one person is refused full-for-you');
  t.equal((await firstClose(late.peer, 10_000, 'the refused socket to see its close')).code, 4503, 'the refusal closes with 4503');
  t.check(!late.peer.provider.isAuthenticated, 'the later arrival was never told it is authenticated');
  t.metric('socketRefusal', late.outcome);
  const bystander = await signedIn(page, 'another person', await tokenFor({ sub: other }), 'read-write'); open.push(bystander);
  t.check(held.every((p) => p.provider.isAuthenticated && p.closed.length === 0), 'the three earlier sockets stayed authenticated and open');
  const marker = `m3-caps-${String(t.seed)}`;
  held[0]?.text.insert(0, marker);
  const stored = await eventually(async () => { const s = await storedText(page); return s.includes(marker) ? s : undefined; }, 20_000, 'an earlier socket\'s edit to be stored');
  t.equal(stored, marker, 'the stored page holds the earlier session\'s edit and nothing from the refused one');

  // A freed place is usable again. The refused client is destroyed first: it would otherwise reconnect with backoff and compete for the freed place.
  late.peer.destroy();
  held[2]?.destroy();
  let reused: Peer | undefined;
  await eventually(async () => {
    const r = await attempt(page, 'after a socket closed', await tokenFor({ sub: heavy }));
    if (r.outcome === 'read-write') { reused = r.peer; open.push(r.peer); return true; }
    r.peer.destroy();
    return undefined;
  }, 30_000, 'the freed socket place to be usable again');
  t.check(reused?.provider.isAuthenticated === true, 'a closed socket frees its place');

  // Documents: four documents of one person on one socket; the fifth is refused.
  const pages = [await newPage(), await newPage(), await newPage(), await newPage(), await newPage()];
  const socket = sharedSocket(); open.push({ destroy: () => { socket.destroy(); } });
  const mine: Doc[] = [];
  for (const [i, p] of pages.slice(0, 4).entries()) {
    const d = openDoc(socket, p, await tokenFor({ sub: docs })); mine.push(d); open.push(d);
    await eventually(() => (d.provider.isAuthenticated ? true : d.failures[0] !== undefined ? true : undefined), 15_000, `document ${String(i + 1)} to answer`);
    t.check(d.provider.isAuthenticated, `document ${String(i + 1)} of 4 is authenticated`);
  }
  const fifth = openDoc(socket, pages[4] as string, await tokenFor({ sub: docs })); open.push(fifth);
  const reason = await eventually(() => fifth.failures[0], 15_000, 'the fifth document to be refused');
  t.equal(reason, 'full-for-you', 'the fifth document of one person is refused full-for-you');
  t.check(!fifth.provider.isAuthenticated, 'the refused document was never told it is authenticated');
  await holds(1500, () => mine.every((d) => d.provider.isAuthenticated && d.closed.length === 0), 'the four earlier documents stay open');
  t.metric('documentRefusal', reason);
});
