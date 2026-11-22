import { eventually, newPage, peer, scenario, storedState, storedText, synced, waitUntil } from '../support.ts';

// A viewer's writes stay local: hasUnsyncedChanges stays true, the other client and the database are unchanged (R4.11, H item 2).
await scenario('read-only', 60_000, async (t) => {
  const page = await newPage();
  const viewer = peer(page, 'vera', 'viewer');
  const writer = peer(page, 'wendy');
  t.onDone(() => { viewer.destroy(); writer.destroy(); });
  await Promise.all([synced(viewer), synced(writer)]);
  t.equal(viewer.provider.authorizedScope, 'readonly', 'the viewer is authorised read-only');
  t.equal(writer.provider.authorizedScope, 'read-write', 'the member is authorised read-write');

  viewer.text.insert(0, 'viewer wrote this');
  // Negative window: any sign of the viewer's change getting through ends it early; none may come in 6 s (twice the 3 s debounce).
  const leaked = async (): Promise<boolean> => !viewer.provider.hasUnsyncedChanges || writer.text.toString() !== '' || (await storedState(page)) !== null;
  t.check(!(await waitUntil(leaked, 6000)), "for 6 s the viewer's change stayed unsynced, unseen by the other client and unstored");
  t.check(viewer.provider.hasUnsyncedChanges, "the viewer's change is still unsynced");
  t.equal(writer.text.toString(), '', 'the other client never sees the viewer text');
  t.equal(await storedState(page), null, 'the database row still has no state after 6 s (the debounce is 3 s)');

  writer.text.insert(0, 'writer text');
  await eventually(async () => ((await storedText(page)) === 'writer text' ? true : undefined), 20_000, 'writer text stored');
  t.check(true, 'the writer text is stored and does not contain the viewer text');
  t.check(viewer.provider.hasUnsyncedChanges, 'the viewer still has unsynced changes at the end');
});
