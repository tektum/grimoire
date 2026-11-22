import { randomUUID } from 'node:crypto';
import { eventually, killApp, scenario, sleep, startApp, waitReady } from '../../support.ts';
import { EditorUser, TOKEN, closeM2Db, converged, docPeer, insertSeededPage, peerSynced, referenceMarkdown, rowOf, typeInOwnParagraph } from '../support.ts';

// Each client types only into its own paragraph (`typeInOwnParagraph`, the rule of markdown-equals-live: unsynced typing never shares a paragraph).
// Two clients type at least 200 characters; the app is killed with SIGKILL inside the debounce window and started again; both clients end
// with the same document, every character typed is in it once, and the restarted server saves it (R4.25, R7.9, R13.9).
const fail = (): never => { throw new Error('no client'); };
await scenario('restart-mid-edit', 240_000, async (t) => {
  t.onDone(async () => { await closeM2Db(); await startApp().catch(() => undefined); });
  const page = randomUUID();
  await insertSeededPage(page, '# Restart\n\nOwna notes\n\nOwnb notes\n\n- one\n- two\n');
  const peers = [docPeer(page, 'rm-a'), docPeer(page, 'rm-b')];
  t.onDone(() => { peers.forEach((p) => { p.destroy(); }); });
  await Promise.all(peers.map((p) => peerSynced(p)));
  const live = new Set<string>();
  const users = peers.map((p, i) => new EditorUser(p, ['a', 'b'][i] ?? 'x', t.rng, live));
  for (const u of users) await u.open();
  t.onDone(() => { users.forEach((u) => { u.close(); }); });
  const chars = (): number => [...live].reduce((n, tok) => n + tok.length, 0);

  for (let i = 0; i < 40; i++) { typeInOwnParagraph(users[i % 2] ?? fail(), 1); await sleep(40); }
  await eventually(async () => (/t[a-z]\d+n\d+e/.test((await rowOf(page))?.markdown ?? '') ? true : undefined), 20_000, 'a first save with typed text');
  for (let i = 0; i < 12; i++) { typeInOwnParagraph(users[i % 2] ?? fail(), 1); await sleep(40); } // fresh edits: the 3 s debounce has not saved them yet
  const typedBeforeKill = chars();
  t.check(typedBeforeKill >= 200, 'at least 200 characters were typed before the kill');
  const savedChars = (): Promise<number> => rowOf(page).then((r) => [...(r?.markdown ?? '').matchAll(TOKEN)].reduce((n, m) => n + m[0].length, 0));
  await killApp('KILL');
  t.metric('typedBeforeKill', typedBeforeKill);
  const savedAtKill = await savedChars();
  t.metric('savedAtKill', savedAtKill);
  t.check(savedAtKill < typedBeforeKill, 'the kill came before the latest edits were saved (the database was behind)');
  await startApp();
  await waitReady();
  await eventually(() => (peers.every((p) => p.provider.synced) && converged(peers.map((p) => p.doc)) ? true : undefined), 90_000, 'both clients to reconnect and agree');
  const [first, second] = await Promise.all(peers.map((p) => referenceMarkdown(p.doc)));
  const present = [...(first ?? '').matchAll(TOKEN)];
  const counts = new Map<string, number>(); for (const m of present) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  const problems = [...live].filter((tok) => counts.get(tok) !== 1).concat([...counts.keys()].filter((tok) => !live.has(tok))).slice(0, 5);
  t.equal(problems, [], 'every token typed before the kill is in the final document exactly once');
  const presentAfterRestart = present.reduce((n, m) => n + m[0].length, 0);
  t.metric('presentAfterRestart', presentAfterRestart);
  t.equal(presentAfterRestart, typedBeforeKill, 'presentAfterRestart equals typedBeforeKill');
  t.equal(second, first, 'the two clients\' final texts are identical');
  const stored = await eventually(async () => { const r = await rowOf(page); return r?.markdown === first ? r : undefined; }, 40_000, 'the restarted server to save the merged document');
  t.check(stored.markdown === first, 'the database holds the Markdown of the merged document');
});
