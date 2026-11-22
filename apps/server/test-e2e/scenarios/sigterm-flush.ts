import { eventually, killApp, newPage, peer, scenario, startApp, storedText, synced, waitExit, waitReady } from '../support.ts';

// SIGTERM with unsaved edits: the latest text is in the database and the container exits 0 (R4.25).
await scenario('sigterm-flush', 120_000, async (t) => {
  const page = await newPage();
  const c = peer(page, 'term');
  t.onDone(async () => { c.destroy(); await startApp().catch(() => undefined); });
  await synced(c);
  c.text.insert(0, 'first line. ');
  await eventually(async () => ((await storedText(page)) === 'first line. ' ? true : undefined), 20_000, 'first save');
  c.text.insert(c.text.length, 'latest unsaved text');
  const latest = c.text.toString();
  t.check((await storedText(page)) !== latest, 'the latest text is not saved yet when SIGTERM is sent');
  await killApp('SIGTERM');
  const code = await waitExit(60_000);
  t.equal(code, 0, 'the container exits with code 0');
  c.destroy();
  await startApp();
  await waitReady();
  t.equal(await storedText(page), latest, 'the latest text is in the database');
});
