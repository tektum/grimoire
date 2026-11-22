import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { BASE, appEvents, eventually, scenario, sleep } from '../../support.ts';
import { EditorUser, FRAGMENT, TOKEN, closeM2Db, docPeer, insertSeededPage, peerSynced, recreateApp, rowOf, typeInOwnParagraph } from '../support.ts';

/** The sentinel the server's test facility looks for (packages/adapters/config-env/src/test-facilities.ts, TEST_SLOW_MARKER): a page whose text has it converts for 15 s, past the 10 s timeout. */
const SENTINEL = 'GRIMOIRE-TEST-SLOW-PAGE-7f3c';
const SLOW_CONVERT_MS = 15_000;
/** `make test-m2-hostile-mutation` sets this to run the same scenario with the breaker disabled; the scenario is then expected to FAIL. */
const NO_BREAKER = process.env['HOSTILE_NEIGHBOUR_NO_BREAKER'] === '1';
/** The proof needs the two hostile pages to hold ALL the workers: the pool is pinned to two whatever the host's environment says (compose passes GRIMOIRE_CONVERT_POOL_SIZE through). */
const POOL_SIZE = 2;
const TYPING_MS = 45_000;
/** What the breaker buys, in failed conversions per hostile page over the 45 s (three runs each on four CPUs: 1 with the breaker, 4 without; each failure holds a worker for the 10 s timeout, so without it 45 s allow 4). The limits sit one either side of the measurements. */
const MAX_FAILURES_WITH_BREAKER = 2; const MIN_FAILURES_WITHOUT_BREAKER = 3;
/** The stack runs this scenario with a short debounce (1 s, at most 3 s under continuous typing), so the hostile page asks for a conversion every 3 s. */
const DEBOUNCE_MS = 1_000; const MAX_DEBOUNCE_MS = 3_000;
/**
 * Bound on how long an ordinary page's typed text may be missing from its stored Markdown. Measured on four CPUs, three runs each: with the breaker the worst age was
 * 10.7 s (both hostile pages hold both workers for one timeout of 10 s at the start, then are cut off); with the breaker disabled it was 19.9 s, 27.8 s and 27.8 s
 * (both workers held for ever). 16 s lies between: 5.3 s above the first (1.5x) and 3.9 s below the least of the second.
 */
const STALE_BOUND_MS = 16_000;
/** After typing stops, an ordinary page must hold everything within the debounce (1 s), one timeout, and a margin. */
const BOUND_MS = 15_000;
const ordinary = (): string => '# Ordinary\n\nOwna notes\n\nOwnb notes\n\nOwnc notes\n\n- one\n- two\n';

// What the breaker buys now that one conversion per page is in flight: a page that always times out stops occupying a worker after its first failure, instead of
// once per edit for ever; with TWO such pages and the breaker disabled both workers are held and ordinary pages go stale (the mutation proof,
// `make test-m2-hostile-mutation`, runs this scenario that way and must fail on exactly that).
// Two hostile pages (their conversion is made to take longer than the 10 s timeout by a test-only switch of the server, keyed on a sentinel in the page,
// so that no other page is slowed) and a page that cannot be seeded at all sit next to five ordinary pages, all edited continuously for 45 s (page 0 by
// three clients; each hostile page once a second). Every 1 s the age of the oldest typed token missing from an ordinary page's stored Markdown is measured and must stay within
// STALE_BOUND_MS; after typing every ordinary page holds every token within BOUND_MS (debounce 1 s, max 3 s: set by this scenario); the hostile page's STATE is saved (its stored state, and a fresh
// client, show the last edit); the breaker opens exactly once for each hostile page and each costs at most MAX_FAILURES_WITH_BREAKER failed conversions; the unseedable page is refused `seed-failed` with one
// `collab.seed_failed` line; no `collab.store_failed` or `collab.convert_alarm` for an ordinary page; `/healthz` answers throughout.
// Clients type only through `typeInOwnParagraph` (the rule of markdown-equals-live).
await scenario('hostile-neighbour', 300_000, async (t) => {
  process.stdout.write(`seed ${String(t.seed)}\n`);
  t.onDone(closeM2Db);
  t.onDone(async () => { await recreateApp({ GRIMOIRE_CONVERT_POOL_SIZE: '', GRIMOIRE_TEST_SLOW_CONVERT_MS: '', GRIMOIRE_TEST_DISABLE_BREAKER: '', GRIMOIRE_COLLAB_DEBOUNCE_MS: '', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '' }); });
  await recreateApp({ GRIMOIRE_CONVERT_POOL_SIZE: String(POOL_SIZE), GRIMOIRE_TEST_SLOW_CONVERT_MS: String(SLOW_CONVERT_MS), GRIMOIRE_TEST_DISABLE_BREAKER: NO_BREAKER ? '1' : '', GRIMOIRE_COLLAB_DEBOUNCE_MS: String(DEBOUNCE_MS), GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: String(MAX_DEBOUNCE_MS) });
  const since = new Date();
  t.metric('breakerDisabled', NO_BREAKER); t.metric('slowConvertMs', SLOW_CONVERT_MS);
  const slow = randomUUID(); const slow2 = randomUUID(); const broken = randomUUID();
  await insertSeededPage(slow, `# Hostile\n\n${SENTINEL}\n`);
  await insertSeededPage(slow2, `# Hostile two\n\n${SENTINEL}\n`);
  await insertSeededPage(broken, `<${'a'.repeat(2_000_000)}`);
  const pages = Array.from({ length: 5 }, () => randomUUID());
  for (const p of pages) await insertSeededPage(p, ordinary());

  let healthFailures = 0; let healthChecks = 0; let healthWorstMs = 0;
  const probes = new Set<Promise<void>>(); // probes still in flight: settled before the count is asserted
  const health = setInterval(() => {
    const at = performance.now(); healthChecks += 1;
    // Bounded: a /healthz that hangs (the stall this scenario exists to catch) times out after 3 s and counts as a failure instead of never being counted.
    const probe: Promise<void> = fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3000) }).then((r) => { if (!r.ok) healthFailures += 1; healthWorstMs = Math.max(healthWorstMs, performance.now() - at); }).catch(() => { healthFailures += 1; }).finally(() => { probes.delete(probe); });
    probes.add(probe);
  }, 250);
  t.onDone(() => { clearInterval(health); });

  // Clients: three on page 0, one on each other ordinary page, one on the slow page, one on the unseedable page.
  const owners: { page: string; tags: string[] }[] = pages.map((page, i) => ({ page, tags: i === 0 ? ['a', 'b', 'c'] : ['a'] }));
  const live = new Map<string, Set<string>>();
  const users: { page: string; user: EditorUser }[] = [];
  for (const { page, tags } of owners) {
    live.set(page, new Set());
    for (const tag of tags) {
      const p = docPeer(page, `hn-${page.slice(0, 4)}-${tag}`);
      t.onDone(() => { p.destroy(); });
      await peerSynced(p, 60_000);
      const u = new EditorUser(p, tag, t.rng, live.get(page) ?? new Set());
      await u.open();
      t.onDone(() => { u.close(); });
      users.push({ page, user: u });
    }
  }
  // The unseedable page is opened once and the client is dropped at the first refusal (the provider would retry by itself and the log throttles repeats per window).
  const badClient = docPeer(broken, 'hn-broken');
  t.onDone(() => { badClient.destroy(); });
  await eventually(() => (badClient.failures.length > 0 && badClient.closes.includes(4501) ? true : undefined), 30_000, 'the unseedable page to be refused with close 4501');
  badClient.destroy();
  const slowClient = docPeer(slow, 'hn-slow');
  t.onDone(() => { slowClient.destroy(); });
  await peerSynced(slowClient, 120_000);
  const slowClient2 = docPeer(slow2, 'hn-slow2');
  t.onDone(() => { slowClient2.destroy(); });
  await peerSynced(slowClient2, 120_000);

  // Typing: every ordinary client every 150 ms; the hostile page gets an edit every second so it is saved at each maxDebounce.
  const lastEdit = new Map<string, number>();
  const typedAt = new Map<string, Map<string, number>>(pages.map((p) => [p, new Map()]));
  let slowEdits = 0; let lastSample = 0;
  let staleWorst = 0; const staleByPage = new Map<string, number>(); let samples = 0;
  const started = Date.now();
  while (Date.now() - started < TYPING_MS) {
    for (const { page, user } of users) {
      typeInOwnParagraph(user, 1); lastEdit.set(page, Date.now());
      const stamps = typedAt.get(page);
      for (const tok of live.get(page) ?? []) if (stamps && !stamps.has(tok)) stamps.set(tok, Date.now());
    }
    if ((Date.now() - started) / 1_000 > slowEdits) {
      slowEdits += 1;
      const fragment = slowClient.doc.getXmlFragment(FRAGMENT);
      const paragraph = new Y.XmlElement('paragraph'); paragraph.insert(0, [new Y.XmlText(`slow page edit ${String(slowEdits)} marker`)]);
      fragment.insert(fragment.length, [paragraph]);
      const fragment2 = slowClient2.doc.getXmlFragment(FRAGMENT);
      const paragraph2 = new Y.XmlElement('paragraph'); paragraph2.insert(0, [new Y.XmlText(`slow page edit ${String(slowEdits)} marker`)]);
      fragment2.insert(fragment2.length, [paragraph2]);
    }
    if (Date.now() - lastSample >= 1_000) {
      lastSample = Date.now(); samples += 1;
      for (const page of pages) {
        const stored = new Set(((await rowOf(page))?.markdown ?? '').match(TOKEN) ?? []);
        const live1 = live.get(page) ?? new Set<string>();
        let worst = 0;
        for (const [tok, at] of typedAt.get(page) ?? []) if (live1.has(tok) && !stored.has(tok)) worst = Math.max(worst, Date.now() - at);
        staleByPage.set(page, Math.max(staleByPage.get(page) ?? 0, worst)); staleWorst = Math.max(staleWorst, worst);
      }
    }
    await sleep(150);
  }
  const typedTotal = users.reduce((s, u) => s + u.user.typed, 0);
  t.metric('ordinaryTokensTyped', typedTotal); t.metric('hostilePageEdits', slowEdits);
  t.metric('staleSamples', samples); t.metric('staleWorstMs', staleWorst); t.metric('staleByPageMs', [...staleByPage.values()]); t.metric('staleBoundMs', STALE_BOUND_MS);
  // What the breaker removes, measured over the whole window for each hostile page. With it, a page that always times out stops occupying a worker after one
  // failure (the next conversions are refused for a while) instead of once per edit for ever. Recorded BEFORE the staleness check so that the mutated run, which
  // must fail on the staleness, has first shown its cause: both hostile pages kept failing (at least MIN_FAILURES_WITHOUT_BREAKER each) and no breaker opened.
  const windowEvents = await appEvents(since);
  const failuresOf = (page: string): number => windowEvents.filter((e) => e.event === 'collab.convert_failed' && e['pageId'] === page).length;
  const openingsOf = (page: string): number => windowEvents.filter((e) => e.event === 'collab.convert_breaker_open' && e['pageId'] === page).length;
  t.metric('hostileConvertFailures', [failuresOf(slow), failuresOf(slow2)]); t.metric('hostileBreakerOpenings', [openingsOf(slow), openingsOf(slow2)]);
  if (NO_BREAKER) {
    t.check(failuresOf(slow) >= MIN_FAILURES_WITHOUT_BREAKER && failuresOf(slow2) >= MIN_FAILURES_WITHOUT_BREAKER, `without the breaker each hostile page kept failing conversions (${String(failuresOf(slow))} and ${String(failuresOf(slow2))}, at least ${String(MIN_FAILURES_WITHOUT_BREAKER)})`);
    t.check(openingsOf(slow) + openingsOf(slow2) === 0, 'without the breaker no breaker opened');
  }
  t.check(staleWorst <= STALE_BOUND_MS, `no ordinary page's stored Markdown was ever more than ${String(STALE_BOUND_MS)} ms behind its typing (worst ${String(staleWorst)} ms)`);

  // Each ordinary page catches up within the bound.
  const catchUps: number[] = [];
  for (const [i, page] of pages.entries()) {
    const want = live.get(page) ?? new Set<string>();
    const done = await eventually(async () => {
      const md = (await rowOf(page))?.markdown ?? '';
      const found = new Map<string, number>(); for (const m of md.matchAll(TOKEN)) found.set(m[0], (found.get(m[0]) ?? 0) + 1);
      return [...want].every((tok) => found.get(tok) === 1) && [...found.keys()].every((tok) => want.has(tok)) ? Date.now() : undefined;
    }, BOUND_MS + 5_000, `ordinary page ${String(i)} to hold every token it was typed`);
    const ms = done - (lastEdit.get(page) ?? done);
    catchUps.push(ms);
    t.check(ms <= BOUND_MS, `ordinary page ${String(i)} caught up ${String(ms)} ms after its last edit (bound ${String(BOUND_MS)} ms)`);
  }
  t.metric('catchUpMs', catchUps); t.metric('catchUpMaxMs', Math.max(...catchUps)); t.metric('boundMs', BOUND_MS);

  // The hostile page's STATE is saved even though its Markdown cannot be made: the stored state, and a client that loads it afresh, hold the last edit.
  const lastMarker = `slow page edit ${String(slowEdits)} marker`;
  const stored = await eventually(async () => {
    const r = await rowOf(slow);
    if (!r?.ydoc) return undefined;
    const d = new Y.Doc(); Y.applyUpdate(d, r.ydoc);
    return d.getXmlFragment(FRAGMENT).toString().includes(lastMarker) ? true : undefined;
  }, 60_000, 'the hostile page\'s last edit to be in its stored state');
  t.check(stored, 'the hostile page\'s stored state holds its last edit');
  slowClient.destroy();
  const fresh = docPeer(slow, 'hn-slow-reload');
  t.onDone(() => { fresh.destroy(); });
  await peerSynced(fresh, 60_000);
  const reloaded = fresh.doc.getXmlFragment(FRAGMENT).toString();
  t.check(reloaded.includes(lastMarker) && reloaded.includes(SENTINEL), 'a client that loads the hostile page afresh sees its content intact');

  // The unseedable page was refused: one log line.
  t.equal(badClient.failures[0], 'seed-failed', 'the unseedable page is refused as seed-failed');
  t.check(badClient.closes.includes(4501), 'the refused client saw close code 4501');
  const events = await appEvents(since);
  t.equal(events.filter((e) => e.event === 'collab.seed_failed' && e['pageId'] === broken).length, 1, 'one collab.seed_failed line for the unseedable page');
  t.equal((await rowOf(broken))?.ydoc, null, 'the unseedable page has no stored state');
  for (const page of [slow, slow2]) {
    t.equal(events.filter((e) => e.event === 'collab.convert_breaker_open' && e['pageId'] === page).length, 1, 'the breaker opened once for the hostile page');
    t.check(failuresOf(page) <= MAX_FAILURES_WITH_BREAKER, `the hostile page cost at most ${String(MAX_FAILURES_WITH_BREAKER)} failed conversions (${String(failuresOf(page))})`);
  }
  for (const page of pages) {
    t.equal(events.filter((e) => (e.event === 'collab.store_failed' || e.event === 'collab.convert_alarm') && e['pageId'] === page).length, 0, 'no store failure or conversion alarm for an ordinary page');
  }
  clearInterval(health);
  await Promise.allSettled([...probes]);
  t.equal(healthFailures, 0, '/healthz answered every time');
  t.metric('healthChecks', healthChecks); t.metric('healthWorstMs', Math.round(healthWorstMs));
});
