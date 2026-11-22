import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { appEvents, eventually, scenario } from '../../support.ts';
import { canonicalOfState, recreateApp, closeM2Db, docPeer, insertSeededPage, peerSynced, rowOf, stateOfMarkdown } from '../support.ts';

// Markdown as an import would leave it: not in canonical form (a `*` bullet, a setext heading, a hard-wrapped paragraph).
const IMPORTED = [
  'Imported page', '=============', '',
  'A paragraph with **bold**, *emphasis*, `code` and a [link](https://example.com/page).', '',
  '* first', '* second', '* third', '',
  '1. one', '2. two', '',
  '> quoted line', '',
  '| a | b |', '|---|---|', '| 1 | 2 |', '',
  '```ts', 'const x = 1;', '```', '',
  'Last paragraph, wrapped by an import tool',
  'onto two lines.', '',
].join('\n');

// The harness inserts a row with Markdown and a null state; 20 clients open it at once; the server seeds it exactly once (R7.9, R7.12, R13.9).
await scenario('seed-once', 120_000, async (t) => {
  const since = new Date();
  t.onDone(closeM2Db);
  // The default allows 10 unauthenticated sockets per address and all 20 clients share one: the limit is raised for this scenario (restore registered first), so that all 20 race the first open.
  t.onDone(async () => { await recreateApp({ GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS: '' }); });
  await recreateApp({ GRIMOIRE_COLLAB_MAX_UNAUTH_SOCKETS_PER_ADDRESS: '100' });
  const page = randomUUID();
  await insertSeededPage(page, IMPORTED);
  t.equal((await rowOf(page))?.ydoc, null, 'the row starts with no state');
  const peers = Array.from({ length: 20 }, (_, i) => docPeer(page, `seed-${String(i).padStart(2, '0')}`));
  t.onDone(() => { peers.forEach((p) => { p.destroy(); }); });
  const t0 = Date.now();
  await Promise.all(peers.map((p) => peerSynced(p, 60_000)));
  t.metric('allSyncedMs', Date.now() - t0);
  // All 20 must really have raced the first open: none may have been turned away by the per-address limit of unauthenticated sockets and come back later.
  t.equal((await appEvents(since)).filter((e) => e.event === 'collab.upgrade_refused').length, 0, 'no upgrade was refused while the 20 clients opened the page');
  const seeds = (await appEvents(since)).filter((e) => e.event === 'collab.seed' && e['pageId'] === page);
  t.equal(seeds.length, 1, 'the app log has exactly one collab.seed line for the page');
  t.equal((await appEvents(since)).filter((e) => e.event === 'collab.seed_failed' && e['pageId'] === page).length, 0, 'no collab.seed_failed line for the page');
  t.metric('seedMs', seeds[0]?.['ms']); t.metric('seedStateBytes', seeds[0]?.['bytes']);

  const row = await eventually(async () => { const r = await rowOf(page); return r?.ydoc ? r : undefined; }, 20_000, 'the seeded state to be stored');
  const canonicalOfRow = await canonicalOfState(row.ydoc ?? new Uint8Array());
  t.equal(canonicalOfRow, await canonicalOfState(await stateOfMarkdown(IMPORTED)), 'the stored state is the seed of the row\'s Markdown (canonical form)');
  const texts = await Promise.all(peers.map((p) => canonicalOfState(Y.encodeStateAsUpdate(p.doc))));
  t.equal(texts.filter((x) => x === canonicalOfRow).length, 20, 'all 20 clients hold the canonical Markdown of the row');
  const shapes = new Set(peers.map((p) => p.doc.getXmlFragment('prosemirror').toString()));
  t.equal(shapes.size, 1, 'all 20 clients hold the same document');
  t.check(canonicalOfRow.includes('**bold**') && canonicalOfRow.includes('Imported page'), 'the canonical Markdown has the imported content');
  t.equal(peers.filter((p) => p.failures.length > 0).length, 0, 'no client was refused');
});
