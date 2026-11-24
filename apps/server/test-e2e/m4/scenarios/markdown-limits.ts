import * as Y from 'yjs';
import { canonicalOfState, docPeer, peerSynced, recreateApp } from '../../m2/support.ts';
import { apiAs, closeDb, errorCode, expectStatus, openCollection, query, scenario, signInAll } from '../support.ts';

// The Markdown protection model, end to end (R7.13, R3.21): Markdown a person supplies is seeded with strict limits and stored together with its editor state;
// a text over a limit is refused with a plain sentence; one person has one conversion at a time; no page ever has Markdown without a state; and a page whose saved
// Markdown has fallen behind its state says so.
const LIMIT_BYTES = 4096;

/** Paragraphs of 46 bytes plus a 2-byte separator: at least `bytes` in all, and about 21 lines per KB, so 100 KB stays under the 8,000-line seed limit (which no setting changes). */
const paragraphs = (bytes: number): string => Array.from({ length: Math.ceil((bytes + 2) / 48) }, (_, i) => `Paragraph number ${String(i).padStart(5, '0')}.`.padEnd(46, ' filler')).join('\n\n');

await scenario('markdown-limits', 240_000, async (t) => { // timeout: recreates the app twice and converts documents of up to 100 KB
  t.onDone(closeDb);
  t.onDone(async () => { await recreateApp({}); });
  await signInAll();
  const bob = apiAs('bob');
  const collection = await openCollection('Exit M4 limits');

  // Within the limits: the page is created, and a client opens it and sees the text.
  const within = expectStatus(await bob.POST('/v1/pages', { body: { collectionId: collection, title: 'Within', markdown: '# Within\n\nSeeded text of the strict limits.\n' } }), 201, 'a page within the limits');
  const peer = docPeer(within.id, 'bob');
  t.onDone(() => { peer.destroy(); });
  await peerSynced(peer);
  t.check((await canonicalOfState(Y.encodeStateAsUpdate(peer.doc))).includes('Seeded text of the strict limits.'), 'the page opens in an editor client with its text');
  peer.destroy();

  // Over a limit: refused 422 with a sentence that names the limit, and no page is made. The limit is the setting, written out for the scenario.
  await recreateApp({ GRIMOIRE_SEED_MAX_MARKDOWN_BYTES: String(LIMIT_BYTES) });
  const countBefore = (await query<{ n: string }>('select count(*) as n from pages'))[0]?.n;
  const over = await bob.POST('/v1/pages', { body: { collectionId: collection, title: 'Over', markdown: paragraphs(LIMIT_BYTES + 100) } });
  t.equal([over.response.status, errorCode(over)], [422, 'invalid'], 'Markdown over the limit is refused 422');
  const sentence = (over.error as { error?: { message?: string } } | undefined)?.error?.message ?? '';
  t.check(sentence.length > 0 && sentence.includes(String(LIMIT_BYTES)), 'the sentence names the limit and its value');
  t.equal((await query<{ n: string }>('select count(*) as n from pages'))[0]?.n, countBefore, 'no page was made');

  // One conversion per person at a time: two creations at once by one person, one is made and one is told to wait.
  await recreateApp({});
  const body = (title: string) => ({ collectionId: collection, title, markdown: paragraphs(100_000) });
  // Several at once, so that at least two overlap whatever the timing: each is a 201 or a 429, at least one of each, and a 429 says rate_limited and when to retry.
  const burst = await Promise.all(['one', 'two', 'three', 'four', 'five'].map((n) => bob.POST('/v1/pages', { body: body(`Burst ${n}`) })));
  const statuses = burst.map((r) => r.response.status);
  t.check(statuses.every((s) => s === 201 || s === 429), `every simultaneous creation is a 201 or a 429 (got ${statuses.join(', ')})`);
  t.check(statuses.includes(201) && statuses.includes(429), 'one person converting several documents at once is served one and told to wait for the rest');
  const waiting = burst.find((r) => r.response.status === 429);
  t.equal(errorCode(waiting ?? { error: undefined }), 'rate_limited', 'the one told to wait gets rate_limited');
  t.check(waiting?.response.headers.get('retry-after') !== null, 'and when to try again (Retry-After)');
  // Another person is not held by the first one's conversion.
  const twoPeople = await Promise.all([apiAs('alice').POST('/v1/pages', { body: body('Other one') }), bob.POST('/v1/pages', { body: body('Other two') })]);
  t.equal(twoPeople.map((r) => r.response.status), [201, 201], 'two people converting at once are both served');

  // No page has Markdown without its editor state.
  const orphans = await query<{ n: string }>('select count(*) as n from pages where markdown is not null and ydoc is null');
  t.equal(orphans[0]?.n, '0', 'no page has Markdown and no state');

  // The stale flag: a page whose saved Markdown is older than its state says so.
  await query('update pages set markdown_stale_since = now() where id = $1', [within.id]);
  const stale = expectStatus(await bob.GET('/v1/pages/{id}', { params: { path: { id: within.id } } }), 200, 'the stale page');
  t.equal([stale.markdownStale, typeof stale.markdownStaleSince], [true, 'number'], 'a page with the flag set shows markdownStale and when');
  await query('update pages set markdown_stale_since = null where id = $1', [within.id]);
  const fresh = expectStatus(await bob.GET('/v1/pages/{id}', { params: { path: { id: within.id } } }), 200, 'the page once the flag is cleared');
  t.equal([fresh.markdownStale, fresh.markdownStaleSince], [false, null], 'a saved page shows markdownStale false and no time');
});
