import type { Peer } from '../support.ts';
import { attempt, closeDb, createCollection, createPageIn, createUser, firstClose, freshSub, grant, newPage, revoke, scenario, setRole, setSuspended, signedIn, tokenFor, waitStack } from '../support.ts';

// Access cut-off during a session (the access re-check, GRIMOIRE_COLLAB_RECHECK_SECONDS=5 in the overlay): four people hold open sessions; then, in the database,
// one is suspended, one loses its entry to a closed collection, one's entry drops from read_write to read, one gets the viewer role. Each is closed `access-changed` within
// a few intervals, a bystander on the same page is not touched, and each reconnects to the CONNECT-TIME answer (forbidden, not-found, readonly, readonly).
// Result fields: cutoffMs per case (milliseconds from the database change to the client seeing the close).
await scenario('access-cutoff', 180_000, async (t) => {
  t.onDone(closeDb);
  await waitStack();
  const subs = { suspended: freshSub('cs'), removed: freshSub('cr'), demoted: freshSub('cd'), viewer: freshSub('cv'), bystander: freshSub('cb') };
  for (const sub of Object.values(subs)) await createUser({ sub });
  const collection = await createCollection(`Cutoff ${String(t.seed)}`, null);
  const closedPage = await createPageIn(collection);
  for (const sub of [subs.suspended, subs.removed, subs.demoted, subs.bystander]) await grant(collection, sub, 'read_write');
  const devPage = await newPage();
  const open: { destroy(): void }[] = [];
  t.onDone(() => { open.forEach((p) => { p.destroy(); }); });
  const sign = async (page: string, label: string, sub: string): Promise<Peer> => { const p = await signedIn(page, label, await tokenFor({ sub }), 'read-write'); open.push(p); return p; };

  const susp = await sign(closedPage, 'to be suspended', subs.suspended);
  const removed = await sign(closedPage, 'to be removed', subs.removed);
  const demoted = await sign(closedPage, 'to be demoted', subs.demoted);
  const bystander = await sign(closedPage, 'bystander', subs.bystander);
  const viewer = await sign(devPage, 'to become a viewer', subs.viewer);

  const changedAt = Date.now();
  await setSuspended(subs.suspended, true);
  await revoke(collection, subs.removed);
  await grant(collection, subs.demoted, 'read');
  await setRole(subs.viewer, 'viewer');
  // Each wait stamps its own close time; the bound is a few re-check intervals (5 s each) plus the time the database changes took.
  // The four waits run together (the time of the slowest, not their sum), and when more than one runs out the failure that is reported is the first in this order, not whichever timer fired first:
  // `Promise.all` reports the first to reject, which with four waits of one deadline is not stable, and the mutation proof (mutation.ts) names the failure it expects.
  const settled = await Promise.allSettled(
    (([['suspended', susp], ['removed', removed], ['demoted', demoted], ['viewer', viewer]]) as [string, Peer][]).map(async ([label, p]) => {
      const c = await firstClose(p, 40_000, `the ${label} session to be closed`);
      return { label, reason: c.reason, ms: Date.now() - changedAt };
    }),
  );
  const results = settled.map((r) => {
    if (r.status === 'rejected') throw r.reason;
    return r.value;
  });
  for (const r of results) {
    t.equal(r.reason, 'access-changed', `${r.label}: closed access-changed`);
    t.check(r.ms < 25_000, `${r.label}: closed within a few re-check intervals (${String(r.ms)} ms)`);
    t.metric(`cutoffMs-${r.label}`, r.ms);
  }
  t.check(bystander.provider.isAuthenticated && bystander.closed.length === 0, 'the bystander with an unchanged entry was not closed');

  // The reconnect gets the connect-time answer.
  const again = async (label: string, page: string, sub: string, expected: string): Promise<void> => {
    const r = await attempt(page, `${label} again`, await tokenFor({ sub }));
    open.push(r.peer);
    t.equal(r.outcome, expected, `${label}: the reconnect is answered ${expected}`);
  };
  await again('suspended', closedPage, subs.suspended, 'forbidden');
  await again('removed', closedPage, subs.removed, 'not-found');
  await again('demoted', closedPage, subs.demoted, 'readonly');
  await again('viewer', devPage, subs.viewer, 'readonly');
  t.check(bystander.provider.isAuthenticated && bystander.closed.length === 0, 'the bystander is still open at the end');
});
