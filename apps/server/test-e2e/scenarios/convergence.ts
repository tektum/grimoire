import { Typist, eventually, newPage, peer, sameText, scenario, sleep, storedText, synced, verifyTokens } from '../support.ts';

// 3 clients, 600 random edits, two disconnect and reconnect events (edits made offline), a late joiner (R4.30, R4.3).
// MUTATIONS (harness self-check): E2E_MUTATE=drop-char makes client b drop the last character of one token before sending;
// E2E_MUTATE=skip-wait skips waiting for convergence.
await scenario('convergence', 180_000, async (t) => {
  const mutate = process.env['E2E_MUTATE'];
  const page = await newPage();
  const peers = [peer(page, 'conv-a'), peer(page, 'conv-b'), peer(page, 'conv-c')];
  t.onDone(() => { peers.forEach((p) => { p.destroy(); }); });
  await Promise.all(peers.map((p) => synced(p)));
  const typists = peers.map((p, i) => new Typist(String.fromCharCode(97 + i), p, t.rng, mutate === 'drop-char' && i === 1 ? 17 : -1));

  const offline = new Set<number>();
  const events = { disconnects: 0, reconnects: 0 };
  const EDITS = 600;
  for (let i = 0; i < EDITS; i++) {
    const who = Math.floor(t.rng() * 3);
    typists[who]?.type();
    // Two outages: client 1 is offline for edits 150..280 (it keeps typing), client 2 for 400..520.
    for (const [idx, from, to] of [[1, 150, 280], [2, 400, 520]] as const) {
      const p = peers[idx];
      if (p === undefined) continue;
      if (i === from) { p.socket.disconnect(); offline.add(idx); events.disconnects += 1; }
      if (i === to) { await p.socket.connect(); offline.delete(idx); events.reconnects += 1; }
    }
    if (i < EDITS - 1) await sleep(35); // about 29 edits a second in all, 10 a second per client, inside the 30 a second budget; no pause after the last edit, the convergence wait follows
  }
  t.equal(offline.size, 0, 'every offline client was reconnected');
  t.equal(events, { disconnects: 2, reconnects: 2 }, 'two disconnect and reconnect events happened');
  const expected = typists.flatMap((x) => x.typed);
  t.equal(expected.length, EDITS, '600 edits were typed');

  if (mutate !== 'skip-wait') {
    await eventually(() => (sameText(peers) ? true : undefined), 60_000, 'three clients to agree');
  }
  t.check(sameText(peers), 'the three clients hold identical text');
  const text = peers[0]?.text.toString() ?? '';
  const verdict = verifyTokens(text, expected);
  t.equal(verdict.problems, [], 'every token typed is present exactly once, nothing else is, and order within each run is kept');
  t.metric('characters', verdict.characters);

  await eventually(async () => ((await storedText(page)) === text ? true : undefined), 30_000, 'the database to hold the converged text');
  t.check(true, 'the stored row equals the converged text');

  const late = peer(page, 'conv-late');
  t.onDone(() => { late.destroy(); });
  await synced(late);
  await eventually(() => (late.text.toString() === text ? true : undefined), 20_000, 'late joiner to match');
  t.check(true, 'a late joiner receives exactly the converged text');
  t.metric('edits', EDITS); t.metric('finalLength', text.length); t.metric('disconnects', events.disconnects); t.metric('reconnects', events.reconnects);
});
