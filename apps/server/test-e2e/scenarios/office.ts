import { Typist, eventually, newPage, peer, sameText, scenario, sleep, synced, verifyTokens } from '../support.ts';
import type { Peer } from '../support.ts';

// The office: 100 users open 3 pages each (300 sockets, one address, 30 pages of 10 users), everyone types, every page converges
// and every client holds exactly the tokens its page's clients typed. Not one of the ten make test-m1 scenarios: `make test-m1-office`.
await scenario('office', 600_000, async (t) => {
  const USERS = 100; const PAGES = 30; const PER_USER = 3; const TOKENS = 12;
  const pages = await Promise.all(Array.from({ length: PAGES }, () => newPage()));
  const byPage: Peer[][] = pages.map(() => []);
  const all: Peer[] = [];
  const typists = new Map<Peer, Typist>();
  t.onDone(() => { all.forEach((p) => { p.destroy(); }); });
  const t0 = Date.now();
  // Batches of 8 stay under the 10 unauthenticated sockets one address may hold at once.
  const jobs: { page: number; user: number }[] = [];
  for (let u = 0; u < USERS; u++) for (let k = 0; k < PER_USER; k++) jobs.push({ page: (u * PER_USER + k) % PAGES, user: u });
  for (let i = 0; i < jobs.length; i += 8) {
    const batch = jobs.slice(i, i + 8).map((j) => {
      const p = peer(pages[j.page] ?? '', `office-${String(j.user)}`);
      byPage[j.page]?.push(p); all.push(p);
      return p;
    });
    await Promise.all(batch.map((p) => synced(p, 30_000)));
  }
  t.equal(all.filter((p) => p.provider.synced).length, 300, 'all 300 clients synced');
  t.metric('connectMs', Date.now() - t0);
  all.forEach((p, i) => { typists.set(p, new Typist(`u${String(i)}x`, p, t.rng)); });
  for (let round = 0; round < TOKENS; round++) {
    for (const p of all) typists.get(p)?.type();
    await sleep(600); // 12 tokens per client in about 7 s, well inside the budget
  }
  let converged = 0;
  for (let i = 0; i < PAGES; i++) {
    const peers = byPage[i] ?? [];
    await eventually(() => (sameText(peers) ? true : undefined), 60_000, `page ${String(i)} to converge`);
    const expected = peers.flatMap((p) => typists.get(p)?.typed ?? []);
    const verdict = verifyTokens(peers[0]?.text.toString() ?? '', expected);
    t.equal(verdict.problems, [], `page ${String(i)}: every token present exactly once, in run order`);
    converged += peers.length;
  }
  t.equal(converged, 300, '300 of 300 clients converged');
  t.metric('clients', 300); t.metric('pages', PAGES); t.metric('converged', converged); t.metric('edits', 300 * TOKENS);
});
