import * as Y from 'yjs';
import { canonicalOfState, docPeer, peerSynced, recreateApp, rowOf } from '../../m2/support.ts';
import { apiAs, appEvents, closeDb, errorCode, eventually, expectStatus, openCollection, scenario, signInAll, tab } from '../support.ts';

// Resetting a page's editing state (R13.8): the administrator replaces the state of a page with the seed of new Markdown. The connected tab is closed by the access
// re-check within its interval, the tab that comes back by itself with the epoch it recorded and an unsent edit is refused `stale-epoch`, and
// neither the old text nor the unsent edit reaches the stored page; the next open seeds the document from the new Markdown.
const RECHECK_SECONDS = 2;
const OLD_TEXT = 'Text before the reset.';
const NEW_TEXT = 'Text after the reset.';
const UNSENT = 'unsent edit of the stale tab';

await scenario('reset-page', 240_000, async (t) => { // timeout: recreates the app twice and waits for a re-check round, a refused reconnect and a seed
  t.onDone(closeDb);
  t.onDone(async () => { await recreateApp({}); });
  await recreateApp({ GRIMOIRE_COLLAB_RECHECK_SECONDS: String(RECHECK_SECONDS) });
  await signInAll();
  const alice = apiAs('alice');
  const bob = apiAs('bob');
  const collection = await openCollection('Exit M4 reset');
  const page = expectStatus(await bob.POST('/v1/pages', { body: { collectionId: collection, title: 'Reset me', markdown: `${OLD_TEXT}\n` } }), 201, 'bob creates the page from Markdown');

  // A tab opens the page and is told the epoch.
  const stale = tab(page.id, 'bob');
  t.onDone(() => { stale.destroy(); });
  await eventually(() => (stale.provider.synced && stale.recorded() !== undefined ? true : undefined), 60_000, 'the tab to sync and be told the state epoch');
  const epochBefore = stale.recorded();
  t.check(stale.doc.getXmlFragment('prosemirror').toString().includes(OLD_TEXT), 'the tab holds the page text');

  // Only the administrator may reset; the reset raises the epoch.
  const refused = await bob.POST('/v1/pages/{id}/reset-state', { params: { path: { id: page.id } }, body: { markdown: `${NEW_TEXT}\n` } });
  t.equal([refused.response.status, errorCode(refused)], [403, 'forbidden'], 'a member cannot reset a page');
  const reset = expectStatus(await alice.POST('/v1/pages/{id}/reset-state', { params: { path: { id: page.id } }, body: { markdown: `${NEW_TEXT}\n` } }), 200, 'the administrator resets the page');
  t.check(epochBefore !== undefined && reset.stateEpoch > epochBefore, 'the reset raised the state epoch');

  // The connected tab is closed by the re-check, within its interval (derived from the setting, with room for one more round and the network).
  await eventually(() => (stale.closes.length > 0 ? true : undefined), (RECHECK_SECONDS * 3 + 10) * 1000, 'the connected tab to be closed by the re-check');

  // The tab loses its network, edits while it is away, and comes back by itself with the epoch it recorded: it is refused.
  stale.dropSocket();
  stale.doc.getText('offline').insert(0, UNSENT);
  await eventually(() => (stale.failures.includes('stale-epoch') ? true : undefined), 60_000, 'the returning tab to be refused stale-epoch');
  t.equal(stale.recorded(), epochBefore, 'the tab still holds the epoch it recorded: it was never let in');

  // Nothing of the tab reached the stored page: the state is the seed of the new Markdown the reset wrote, and it holds neither the old text nor the unsent edit.
  const row = await rowOf(page.id);
  const stored = await canonicalOfState(row?.ydoc ?? new Uint8Array());
  t.check(row?.ydoc !== null && stored.includes(NEW_TEXT) && !stored.includes(OLD_TEXT), 'the stored state is the seed of the new Markdown');
  t.check(!Buffer.from(row?.ydoc ?? new Uint8Array()).includes(Buffer.from(UNSENT)), 'the stored state holds no trace of the unsent edit');
  t.check(row?.markdown?.includes(NEW_TEXT) === true && row.markdown.includes(OLD_TEXT) === false, 'the stored Markdown is the new one');
  const saved = expectStatus(await bob.GET('/v1/pages/{id}/markdown', { params: { path: { id: page.id } }, parseAs: 'text' }), 200, 'the saved Markdown after the refusal');
  t.check(saved.includes(NEW_TEXT) && !saved.includes(OLD_TEXT) && !saved.includes(UNSENT), 'the saved Markdown is the new text only');
  const rowAfter = await rowOf(page.id);
  t.equal([rowAfter?.markdown, rowAfter?.updated_at, rowAfter?.ydoc_size], [row?.markdown, row?.updated_at, row?.ydoc_size], 'the row (Markdown, update time, state size) is unchanged by the refused reconnect');
  t.check(Buffer.from(rowAfter?.ydoc ?? new Uint8Array()).equals(Buffer.from(row?.ydoc ?? new Uint8Array())), 'the stored state is byte for byte what the reset left');

  // A fresh client at the new epoch sees the new text only.
  const fresh = docPeer(page.id, 'bob');
  t.onDone(() => { fresh.destroy(); });
  await peerSynced(fresh);
  const freshText = await canonicalOfState(Y.encodeStateAsUpdate(fresh.doc));
  t.check(freshText.includes(NEW_TEXT) && !freshText.includes(OLD_TEXT) && !freshText.includes(UNSENT), 'a fresh client sees the new text only');
  fresh.destroy();

  // A reset without Markdown clears the state: the next open seeds the document from the page's saved Markdown.
  const clearedAt = new Date();
  expectStatus(await alice.POST('/v1/pages/{id}/reset-state', { params: { path: { id: page.id } }, body: {} }), 200, 'the administrator resets the state alone');
  const cleared = await eventually(async () => { const r = await rowOf(page.id); return r?.ydoc === null ? r : undefined; }, 30_000, 'the state to be cleared');
  t.check(cleared.markdown?.includes(NEW_TEXT) === true, 'the saved Markdown stays');
  const reopened = docPeer(page.id, 'bob');
  t.onDone(() => { reopened.destroy(); });
  await peerSynced(reopened);
  t.check((await canonicalOfState(Y.encodeStateAsUpdate(reopened.doc))).includes(NEW_TEXT), 'the next open shows the saved Markdown');
  const events = await appEvents(clearedAt);
  t.check(events.some((e) => e.event === 'collab.seed' && e['pageId'] === page.id), 'the app log shows the page seeded from its Markdown at that open');
});
