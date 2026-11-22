import { eventually, newPage, peer, scenario, synced } from '../support.ts';
import type { Peer } from '../support.ts';

// The 101st connection to one page is refused (page-full), the first 100 are unaffected, and a slot frees on disconnect (R4.15).
await scenario('connection-cap', 120_000, async (t) => {
  const page = await newPage();
  const crowd: Peer[] = [];
  t.onDone(() => { crowd.forEach((p) => { p.destroy(); }); });
  // One user each (the message budget is per user and page); batches of 8 stay under the 10 unauthenticated sockets one address may hold.
  for (let i = 0; i < 100; i += 8) {
    const batch = Array.from({ length: Math.min(8, 100 - i) }, (_, j) => peer(page, `cap-${String(i + j)}`));
    crowd.push(...batch);
    await Promise.all(batch.map((p) => synced(p, 20_000)));
  }
  t.equal(crowd.filter((p) => p.provider.synced).length, 100, 'the first 100 connections are all synced');

  const extra = peer(page, 'cap-extra');
  t.onDone(() => { extra.destroy(); });
  await eventually(() => (extra.failures.includes('page-full') ? true : undefined), 10_000, 'the 101st connection to be refused');
  t.equal(extra.failures, ['page-full'], 'the 101st connection is refused with page-full');
  t.check(!extra.provider.synced, 'the refused client never synced');

  crowd[0]?.text.insert(0, 'ok');
  await eventually(() => (crowd[99]?.text.toString() === 'ok' ? true : undefined), 10_000, 'edit to reach the last client');
  t.check(true, 'the 100 admitted clients still exchange edits');

  extra.destroy();
  crowd[99]?.destroy();
  // The server frees the slot when it has handled the disconnect: retry with a fresh client until one is admitted.
  let attempts = 0;
  const later = await eventually(async () => {
    attempts += 1;
    const attempt = peer(page, `cap-later-${String(attempts)}`);
    t.onDone(() => { attempt.destroy(); });
    const admitted = await eventually(() => (attempt.provider.synced ? true : attempt.failures.length > 0 ? 'refused' : undefined), 10_000, 'a new client to be admitted or refused');
    if (admitted === true) return attempt;
    attempt.destroy();
    return undefined;
  }, 10_000, 'a slot to free after one disconnect');
  t.metric('laterAttempts', attempts);
  t.equal(later.text.toString(), 'ok', 'after one disconnect a new client is admitted and loads the page');
});
