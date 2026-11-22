import { appEvents, compose, eventually, killApp, newPage, peer, psqlAdmin, scenario, startApp, storedText, synced, waitExit, waitReady } from '../support.ts';

// A database that refuses UPDATE: store_failed is logged repeatedly, the text lands once the privilege returns; with the failure
// continuing at SIGTERM the container exits 1 with store_abandoned (R4.24, R4.25).
await scenario('store-failure', 240_000, async (t) => {
  // An earlier run that was killed (SIGKILL) can leave UPDATE revoked: starting from that state would make every check meaningless.
  const has = (await compose('exec', '-T', 'postgres', 'psql', '-U', 'grimoire_admin', '-d', 'grimoire', '-tA', '-c', "select has_table_privilege('grimoire_app', 'pages', 'UPDATE')")).trim();
  if (has !== 't') throw new Error("grimoire_app has no UPDATE on pages (an earlier run was interrupted). Fix: docker compose -p grimoire exec -T postgres psql -U grimoire_admin -d grimoire -c 'grant update on pages to grimoire_app'");
  const page = await newPage();
  const c = peer(page, 'store');
  const since = new Date(Date.now() - 1000);
  t.onDone(async () => {
    c.destroy();
    // Both are attempted; a failed grant is rethrown after the app was started again, so the scenario runner fails the run instead of moving on with a stack that cannot save.
    let grantError: unknown;
    await psqlAdmin('grant update on pages to grimoire_app').catch((e: unknown) => { grantError = e; });
    await startApp().catch(() => undefined);
    if (grantError !== undefined) throw grantError;
  });
  await synced(c);
  await psqlAdmin('revoke update on pages from grimoire_app');
  c.text.insert(0, 'first');
  const failed = async (): Promise<number> => (await appEvents(since)).filter((e) => e.event === 'collab.store_failed' && e['pageId'] === page).length;
  await eventually(async () => ((await failed()) >= 2 ? true : undefined), 20_000, 'at least 2 collab.store_failed lines');
  t.check((await failed()) >= 2, 'at least 2 collab.store_failed lines within 20 s');
  t.equal(await storedText(page), '', 'nothing was stored while the privilege was missing');

  await psqlAdmin('grant update on pages to grimoire_app');
  await eventually(async () => ((await storedText(page)) === 'first' ? true : undefined), 60_000, 'the text to be saved after the grant');
  t.equal(await storedText(page), 'first', 'the text is saved after the privilege returns');

  const failuresBefore = await failed(); // the first outage's retries are already counted: only failures beyond this belong to the second revoke
  await psqlAdmin('revoke update on pages from grimoire_app');
  c.text.insert(c.text.length, ' second');
  await eventually(async () => ((await failed()) > failuresBefore ? true : undefined), 20_000, 'a new store failure after the second revoke');
  const sent = new Date();
  await killApp('SIGTERM');
  const t0 = Date.now();
  const code = await waitExit(60_000);
  t.metric('exitMs', Date.now() - t0);
  t.equal(code, 1, 'the container exits with code 1 while stores keep failing');
  t.check(Date.now() - t0 < 60_000, 'the container exits within 60 s');
  const abandoned = (await appEvents(sent)).filter((e) => e.event === 'collab.store_abandoned' && e['pageId'] === page);
  t.equal(abandoned.length, 1, 'one collab.store_abandoned line names the page');
  c.destroy();
  await psqlAdmin('grant update on pages to grimoire_app');
  await startApp();
  await waitReady();
  t.equal(await storedText(page), 'first', 'the abandoned edit was not stored');
});
