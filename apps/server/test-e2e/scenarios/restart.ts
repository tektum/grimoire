import { Typist, eventually, killApp, newPage, peer, sameText, scenario, sleep, startApp, storedText, synced, verifyTokens, waitReady } from '../support.ts';

// Two clients type at least 200 characters; the server is killed with SIGKILL inside the debounce window and started again; both
// clients end identical and contain every character typed before the kill (R4.25, R4.15; H item 6).
await scenario('restart', 240_000, async (t) => {
  const page = await newPage();
  const a = peer(page, 'rest-a'); const b = peer(page, 'rest-b');
  t.onDone(async () => { a.destroy(); b.destroy(); await startApp().catch(() => undefined); });
  await Promise.all([synced(a), synced(b)]);
  const typists = [new Typist('a', a, t.rng), new Typist('b', b, t.rng)];
  for (let i = 0; i < 60; i++) { typists[i % 2]?.type(); await sleep(60); }
  const typedBeforeKill = (): number => typists.reduce((n, x) => n + x.typed.reduce((m, tok) => m + tok.length, 0), 0);
  t.check(typedBeforeKill() >= 200, 'at least 200 characters were typed before the kill');
  await eventually(async () => ((await storedText(page)).length > 0 ? true : undefined), 20_000, 'a first save');
  for (let i = 0; i < 12; i++) { typists[i % 2]?.type(); await sleep(60); } // fresh edits: the debounce (3 s) has not saved them
  const typed = typedBeforeKill();
  await killApp('KILL');
  t.metric('typedBeforeKill', typed);
  const savedAtKill = (await storedText(page)).length;
  t.metric('savedAtKill', savedAtKill);
  t.check(savedAtKill < typed, 'the kill came before the latest edits were saved (the database was behind)');
  await startApp();
  await waitReady();
  const expected = typists.flatMap((x) => x.typed);
  await eventually(() => (sameText([a, b]) && a.provider.synced && b.provider.synced ? true : undefined), 90_000, 'both clients to reconnect and agree');
  const text = a.text.toString();
  const verdict = verifyTokens(text, expected);
  t.equal(verdict.problems, [], 'every token typed before the kill is present exactly once after the restart');
  t.metric('presentAfterRestart', verdict.characters);
  t.equal(verdict.characters, typed, 'presentAfterRestart equals typedBeforeKill');
  t.equal(b.text.toString(), text, 'the two clients hold identical text');
  await eventually(async () => ((await storedText(page)) === text ? true : undefined), 30_000, 'the restarted server to store the merged text');
  t.check(true, 'the database holds the merged text after the restart');
});
