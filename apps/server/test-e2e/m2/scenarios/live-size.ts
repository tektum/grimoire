import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { appEvents, eventually, newPage, scenario } from '../../support.ts';
import { FRAGMENT, Pinger, closeM2Db, docPeer, insertSeededPage, peerSynced, rowOf, stateOfMarkdown } from '../support.ts';
import { devToken } from '../../support.ts';

// 72 to 78 percent of the default state cap (1,000,000 bytes): a large page that is still storable.
const LOW = 720_000; const HIGH = 780_000;

/** One tile of prose with some formatting and a short list; tiles differ, so the state does not shrink by repetition. */
const tile = (i: number): string => [
  `## Section ${String(i)}`, '',
  `Paragraph ${String(i)} of the long page: the quick brown fox jumps over the lazy dog, **bold ${String(i)}**, *emphasis*, \`code${String(i)}\` and a [link](https://example.com/${String(i)}).`, '',
  `- item ${String(i)}.a with some words`, `- item ${String(i)}.b with some other words`, '',
].join('\n');
const tiled = (n: number): string => Array.from({ length: n }, (_, i) => tile(i)).join('\n');

// A row whose Markdown, tiled, seeds to a Yjs state of 0.72 to 0.78 MB; one edit; the save lands while a second client keeps asking the server
// for an answer. The live state cap (1,000,000 bytes by default) makes a 1 MB Markdown page impossible (R7.12).
await scenario('live-size', 240_000, async (t) => {
  const since = new Date();
  t.onDone(closeM2Db);
  // Find the tile count: seed in process, scale by the measured bytes per tile, repeat until the state is in range.
  let n = 800; let state: Uint8Array = new Uint8Array(); let markdown = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    markdown = tiled(n); state = await stateOfMarkdown(markdown);
    if (state.byteLength >= LOW && state.byteLength <= HIGH) break;
    n = Math.max(1, Math.round(n * (((LOW + HIGH) / 2) / state.byteLength)));
  }
  t.check(state.byteLength >= LOW && state.byteLength <= HIGH, `the seeded state is between ${String(LOW)} and ${String(HIGH)} bytes`);
  const markdownBytes = Buffer.byteLength(markdown);
  t.metric('tiles', n); t.metric('stateBytes', state.byteLength); t.metric('markdownBytes', markdownBytes);
  t.metric('bytesPerMarkdownKb', Math.round(state.byteLength / (markdownBytes / 1024)));

  const page = randomUUID();
  await insertSeededPage(page, markdown);
  const small = await newPage();
  const pinger = await Pinger.open(small, devToken('ls-ping', 'member'));
  t.onDone(() => { pinger.close(); });
  const stopIdle = pinger.start();
  await new Promise((r) => setTimeout(r, 250));
  const idle = stopIdle();
  t.metric('idlePingMs', Math.round(idle.max * 10) / 10);

  // Seed: the first client opens the page.
  const stopSeed = pinger.start();
  const t0 = Date.now();
  const client = docPeer(page, 'ls-editor');
  t.onDone(() => { client.destroy(); });
  await peerSynced(client, 120_000);
  const seedMs = Date.now() - t0;
  const duringSeed = stopSeed();
  t.metric('seedMs', seedMs); t.metric('maxPingDuringSeedMs', Math.round(duringSeed.max * 10) / 10);
  t.equal(client.doc.getXmlFragment(FRAGMENT).length > 0, true, 'the client holds the seeded document');
  const logged = (await appEvents(since)).filter((e) => e.event === 'collab.seed' && e['pageId'] === page);
  t.equal(logged.length, 1, 'one collab.seed line');
  t.metric('serverSeedMs', logged[0]?.['ms']);
  t.metric('seedStateBytesLogged', logged[0]?.['bytes']);
  const seededRow = await eventually(async () => { const r = await rowOf(page); return r?.ydoc ? r : undefined; }, 30_000, 'the seeded state to be stored');
  t.metric('storedStateBytes', seededRow.ydoc?.byteLength);

  // One edit: a paragraph at the end, as the editor would write it (an element of the schema with a text run).
  const before = seededRow.updated_at;
  const stopSave = pinger.start();
  const e0 = Date.now();
  const fragment = client.doc.getXmlFragment(FRAGMENT);
  const paragraph = new Y.XmlElement('paragraph'); const run = new Y.XmlText('one edit after the seed, typed by the live-size scenario');
  paragraph.insert(0, [run]);
  fragment.insert(fragment.length, [paragraph]);
  const saved = await eventually(async () => { const r = await rowOf(page); return r !== undefined && r.updated_at !== before && r.markdown?.includes('one edit after the seed') === true ? r : undefined; }, 60_000, 'the edit to be saved');
  const saveMs = Date.now() - e0;
  const duringSave = stopSave();
  t.metric('saveMs', saveMs); t.metric('maxPingDuringSaveMs', Math.round(duringSave.max * 10) / 10); t.metric('pingSamplesDuringSave', duringSave.count);
  t.metric('maxPingMs', Math.round(duringSave.max * 10) / 10);
  t.check(duringSave.max < 100, 'a second client\'s ping during the save is answered within 100 ms');
  // The seed window is only recorded: the client that receives the 0.75 MB state applies it in this same process and stalls this loop too.
  t.metric('savedMarkdownBytes', Buffer.byteLength(saved.markdown ?? ''));
  const events = await appEvents(since);
  const savedEvent = events.filter((e) => e.event === 'collab.saved' && e['pageId'] === page).at(-1);
  t.metric('serverConvertMs', savedEvent?.['convertMs']); t.metric('serverWriteMs', savedEvent?.['writeMs']);
  t.check(saved.text_content !== null && saved.text_content.length > 0, 'the search text is stored');
  t.equal(events.filter((e) => e.event === 'collab.convert_alarm' && e['pageId'] === page).length, 0, 'no conversion alarm');
  t.equal(client.closes.filter((c) => c !== 1000).length, 0, 'the client was not disconnected abnormally');
});
