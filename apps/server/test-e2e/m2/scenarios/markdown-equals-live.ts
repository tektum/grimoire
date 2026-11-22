import { randomUUID } from 'node:crypto';
import { appEvents, eventually, scenario, sleep, userIdOf, waitUntil } from '../../support.ts';
import type { DocPeer } from '../support.ts';
import { EditorUser, TOKEN, closeM2Db, converged, docPeer, insertSeededPage, peerSynced, recreateApp, referenceMarkdown, rowOf, typeInOwnParagraph } from '../support.ts';
import * as Y from 'yjs';

const SEED = [
  '# Field notes', '',
  'The first paragraph says very little, on purpose.', '',
  'Owna notes', '', 'Ownb notes', '', 'Ownc notes', '', 'Ownd notes', '',
  'A second paragraph with **bold** and `code` in it.', '',
  '## A list', '',
  '- alpha item', '- beta item', '- gamma item', '',
  '> A quotation to type into.', '',
  '```', 'a code block line', '```', '',
  'The last paragraph.', '',
].join('\n');
const EDITS = 600;
const JOIN_AT = 300;

// Three clients with real editors (and a fourth that joins late, at edit 300) make 600 random edits on one page; clients b and c go offline and
// come back; the Markdown the server stored equals the Markdown of the reference editor over the document they converged on, and no token typed
// is missing or doubled (R3.5, R4.30, R7.9).
//
// THE RULE (R3.27; why: docs/proof/m2-live-save.md, "Known limit: two people typing at the same spot can scramble each other's words"):
//  1. Unsynced typing (a client offline, or typing before the others have its edits) goes into the client's OWN paragraph (`Owna `, `Ownb `, ...),
//     through `typeInOwnParagraph`. Concurrent with it, in the same paragraph, is nobody.
//  2. Restructuring (a paragraph split, the deletion of a token) and typing anywhere else (`editSettled`) run only when ALL clients are online
//     and hold the same state (same state vector, same document) before the edit, and the scenario waits for agreement again after it.
//  What stays concurrent: typing against typing in different paragraphs, three or four clients at once, offline work and reconnect (the
//  offline client's typing meets the others' typing in other paragraphs), a late joiner who types at once.
// The seed is E2E_SEED (printed at the start and on failure).
await scenario('markdown-equals-live', 300_000, async (t) => {
  process.stdout.write(`seed ${String(t.seed)}\n`);
  const since = new Date();
  await recreateApp({ GRIMOIRE_LOG_LEVEL: 'debug' }); // collab.save_skipped is a debug line
  t.onDone(async () => { await closeM2Db(); await recreateApp({}); });
  const page = randomUUID();
  await insertSeededPage(page, SEED);
  const peers = ['mel-a', 'mel-b', 'mel-c'].map((u) => docPeer(page, u));
  t.onDone(() => { peers.forEach((p) => { p.destroy(); }); });
  await Promise.all(peers.map((p) => peerSynced(p)));
  const live = new Set<string>();
  const users = peers.map((p, i) => new EditorUser(p, ['a', 'b', 'c'][i] ?? 'x', t.rng, live));
  for (const u of users) await u.open();
  t.onDone(() => { users.forEach((u) => { u.close(); }); });

  const down = new Set<DocPeer>();
  const settle = (): Promise<void> => eventually(() => (peers.every((p) => !down.has(p) && p.provider.synced) && converged(peers.map((p) => p.doc)) ? true : undefined), 30_000, 'all clients to agree').then(() => undefined);
  const events: readonly [number, number, 'down' | 'up'][] = [[150, 1, 'down'], [260, 1, 'up'], [380, 2, 'down'], [470, 2, 'up']];
  for (let i = 0; i < EDITS; i++) {
    for (const [n, who, what] of events) {
      if (n !== i) continue;
      const p = peers[who];
      if (p === undefined) continue;
      if (what === 'down') { p.socket.disconnect(); down.add(p); } else { await p.socket.connect(); down.delete(p); }
    }
    if (i === JOIN_AT) {
      const late = docPeer(page, 'mel-d');
      peers.push(late);
      t.onDone(() => { late.destroy(); });
      await peerSynced(late);
      const lateUser = new EditorUser(late, 'd', t.rng, live);
      await lateUser.open();
      users.push(lateUser);
      t.onDone(() => { lateUser.close(); });
    }
    const allOnline = peers.every((p) => !down.has(p));
    const settled = allOnline && t.rng() < 0.15;
    const user = users[Math.floor(t.rng() * users.length)];
    if (settled) {
      await settle();
      user?.editSettled();
      await settle();
    } else if (user !== undefined) {
      typeInOwnParagraph(user, 1);
    }
    if (i % 5 === 0) await sleep(Math.floor(t.rng() * 8));
  }

  const typed = users.reduce((n, u) => n + u.typed, 0);
  t.metric('edits', EDITS); t.metric('tokensTyped', typed); t.metric('tokensRemoved', users.reduce((n, u) => n + u.removed, 0)); t.metric('paragraphSplits', users.reduce((n, u) => n + u.splits, 0));
  t.check(typed > 300, 'most of the 600 edits typed text');

  await eventually(() => (peers.every((p) => p.provider.synced) && converged(peers.map((p) => p.doc)) ? true : undefined), 60_000, 'the clients to converge');
  const reference = await referenceMarkdown(peers[0]?.doc ?? new Y.Doc());
  t.metric('referenceMarkdownBytes', Buffer.byteLength(reference));
  const expected = process.env['M2_FORCE_MISMATCH'] === '1' ? `${reference}x` : reference;

  // CONTENT: the live tokens appear in the reference Markdown exactly once, removed ones not at all.
  const found = new Map<string, number>();
  for (const m of reference.matchAll(TOKEN)) found.set(m[0], (found.get(m[0]) ?? 0) + 1);
  const problems = [...live].filter((tok) => found.get(tok) !== 1).slice(0, 5).concat([...found.keys()].filter((tok) => !live.has(tok)).slice(0, 5));
  t.equal(problems, [], 'every token typed and not deleted is in the converged document exactly once, and no deleted one is');
  t.metric('liveTokens', live.size);

  const stored = await eventually(async () => { const r = await rowOf(page); return r?.markdown === expected ? r : undefined; }, 40_000, 'the stored Markdown to equal the reference editor\'s Markdown')
    .catch(async (e: unknown) => {
      const r = await rowOf(page);
      const got = r?.markdown ?? '';
      let i = 0; while (i < got.length && got[i] === expected[i]) i += 1;
      throw new Error(`${e instanceof Error ? e.message : String(e)} (stored ${String(got.length)} chars, expected ${String(expected.length)}; first difference at ${String(i)}: stored ${JSON.stringify(got.slice(i, i + 40))} vs expected ${JSON.stringify(expected.slice(i, i + 40))})`);
    });
  t.check(stored.markdown === expected, 'the stored Markdown equals the reference editor Markdown character for character');
  t.check(stored.text_content !== null && stored.text_content.length > 0, 'the search text is stored');
  for (const tok of live) if (!(stored.text_content ?? '').includes(tok)) { t.check(false, `the search text lacks ${tok}`); }
  t.check(true, 'every live token is in the search text');

  // A change the Markdown cannot show (two letters typed and deleted again): the state changes, so the server stores the state (ydoc, ydoc_size,
  // updated_at, last editor) and logs collab.saved; markdown, text_content and markdown_hash stay as they were; collab.save_skipped is for
  // identical state bytes only, so it does not appear for this page.
  const countOf = async (event: string): Promise<number> => (await appEvents(since)).filter((e) => e.event === event && e['pageId'] === page).length;
  const savedBefore = await countOf('collab.saved'); const skippedBefore = await countOf('collab.save_skipped');
  const first = users[0];
  if (first === undefined) throw new Error('no client');
  await settle();
  first.touch(); await sleep(100); first.untouch();
  const changed = await eventually(async () => { const r = await rowOf(page); return r?.ydoc !== null && r?.ydoc !== undefined && stored.ydoc !== null && Buffer.compare(Buffer.from(r.ydoc), Buffer.from(stored.ydoc)) !== 0 ? r : undefined; }, 30_000, 'the state to be stored after a change the Markdown cannot show');
  t.check(changed.markdown === stored.markdown && changed.text_content === stored.text_content, 'markdown and text_content are unchanged by the invisible change');
  t.equal(changed.markdown_hash === null ? null : Buffer.from(changed.markdown_hash).toString('hex'), stored.markdown_hash === null ? null : Buffer.from(stored.markdown_hash).toString('hex'), 'markdown_hash is unchanged by the invisible change');
  t.check(changed.updated_at > stored.updated_at, 'updated_at moved on');
  t.equal(changed.ydoc_size, changed.ydoc?.byteLength, 'ydoc_size matches the stored state');
  // dev users have rows (local mode provisions them): the column holds the touching user's row id, never the token subject.
  t.equal(changed.last_edited_by, await userIdOf('mel-a'), "last_edited_by is mel-a's users.id");
  await eventually(async () => ((await countOf('collab.saved')) > savedBefore ? true : undefined), 10_000, 'a collab.saved line for the invisible change');
  t.equal(await countOf('collab.save_skipped'), skippedBefore, 'no collab.save_skipped line: the state bytes changed');

  // Opening and closing the page without an edit writes nothing.
  // The last change (the untouch) is stored once the stored state holds exactly what the clients hold and the newest collab.saved line
  // is that write's; a save still pending after that finds identical bytes and is skipped, so updated_at no longer moves.
  const holder = peers[0];
  if (holder === undefined) throw new Error('no client');
  await settle();
  const quiet = await eventually(async () => {
    const r = await rowOf(page);
    if (r?.ydoc === null || r?.ydoc === undefined) return undefined;
    const storedDoc = new Y.Doc(); Y.applyUpdate(storedDoc, r.ydoc);
    if (!converged([storedDoc, holder.doc])) return undefined;
    const lastSaved = (await appEvents(since)).filter((e) => e.event === 'collab.saved' && e['pageId'] === page).at(-1);
    return lastSaved?.['stateBytes'] === r.ydoc_size ? r : undefined;
  }, 30_000, 'the last change to be stored and logged');
  const savedQuiet = await countOf('collab.saved');
  const written = async (): Promise<boolean> => {
    const r = await rowOf(page);
    return r?.updated_at !== quiet?.updated_at || (await countOf('collab.saved')) !== savedQuiet;
  };
  const visitor = docPeer(page, 'mel-visitor');
  await peerSynced(visitor);
  // Negative windows: a write would end them early; none may come while the visitor is open or within the 3 s save debounce after.
  const writtenWhileOpen = await waitUntil(written, 500);
  visitor.destroy();
  const writtenAfterClose = await waitUntil(written, 4_500);
  t.check(!writtenWhileOpen && !writtenAfterClose, 'no write began while the visitor was open or within the save debounce after it left');
  const afterVisit = await rowOf(page);
  t.equal(afterVisit?.updated_at, quiet?.updated_at, 'opening and closing the page left updated_at unchanged');
  t.check(afterVisit?.ydoc !== null && afterVisit?.ydoc !== undefined && quiet?.ydoc !== null && quiet?.ydoc !== undefined && Buffer.compare(Buffer.from(afterVisit.ydoc), Buffer.from(quiet.ydoc)) === 0, 'opening and closing the page left the state unchanged');
  t.equal(await countOf('collab.saved'), savedQuiet, 'opening and closing the page logged no collab.saved line');
  t.equal((await appEvents(since)).filter((e) => e.event === 'collab.convert_alarm' && e['pageId'] === page).length, 0, 'no conversion alarm was raised for the page');
});
