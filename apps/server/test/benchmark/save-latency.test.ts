import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { insertPage } from '@tektum/grimoire-test-support/database';
import { createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { eventually, DEV_COLLECTION, devFixtures, newPage } from '../collab/support.js';
import { ALICE, appUrl, columnsOf, connectDoc } from '../collab/m2-support.js';
import type { DocClient } from '../collab/m2-support.js';

// measurement (not a pass/fail test): time from an edit to the Markdown stored, for a small page and a page near the state cap,
// and what a cap-sized conversion does to the save latency of another page (pool size 1). Debounce is 300 ms; the net figure subtracts it.
const DB = 'grimoire_m2t04_bench';
const DEBOUNCE = 300;
let server: ServerProcess;
const clients: DocClient[] = [];

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  // `last_edited_by` has a foreign key to users since 0004: without the editor's row every save fails (the benchmark had silently stopped working).
  await sqlAdmin(DB, `insert into users (id, descope_user_id, email, name) values ('${ALICE}', 'alice', 'alice@example.invalid', 'alice') on conflict do nothing`);
  server = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_DEBOUNCE_MS: String(DEBOUNCE), GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '1000' } });
}, 60_000);
afterAll(async () => { clients.forEach((c) => { c.destroy(); }); await server.kill(); await dropTestDatabase(DB); });

const run = (c: DocClient, text: string): void => {
  const fragment = c.doc.getXmlFragment('prosemirror');
  const p = fragment.get(fragment.length - 1);
  const t = p instanceof Y.XmlElement ? p.get(p.length - 1) : undefined;
  if (!(t instanceof Y.XmlText)) throw new Error('no text run');
  t.insert(t.length, text);
};
const open = async (page: string): Promise<DocClient> => {
  const c = connectDoc(server.port, page, ALICE); clients.push(c);
  try { await eventually(() => (c.provider.synced ? true : undefined), 60_000, 'synced'); } catch (e) { process.stderr.write(`OPEN-FAILED failures=${c.failures.join()} closes=${c.closes.join()} ${JSON.stringify(server.events.filter((x) => String(x['event']).startsWith('collab.seed') || String(x['event']).includes('refused')).slice(-3))}`); throw e; }
  return c;
};
/** Edits, returns ms until the row's Markdown contains the marker. */
async function editAndMeasure(page: string, c: DocClient, marker: string): Promise<number> {
  const t0 = performance.now();
  run(c, marker);
  await eventually(async () => ((await columnsOf(DB, page))?.markdown?.includes(marker) ? true : undefined), 180_000, `stored ${marker}`);
  return Math.round(performance.now() - t0);
}
const savedLines = (page: string) => server.events.filter((e) => e['event'] === 'collab.saved' && e['pageId'] === page).map((e) => ({ stateBytes: e['stateBytes'], markdownBytes: e['markdownBytes'], convertMs: e['convertMs'], writeMs: e['writeMs'] }));

describe('save latency', { timeout: 600_000 }, () => {
  it('measures', async () => {
    const out: Record<string, unknown> = { debounceMs: DEBOUNCE };
    const small = newPage(); await devFixtures(DB); await insertPage((sql) => sqlAdmin(DB, sql), { collection_id: DEV_COLLECTION, id: small, markdown: 'hello world' });
    const cs = await open(small);
    const smallRuns: number[] = [];
    for (let i = 0; i < 5; i++) smallRuns.push(await editAndMeasure(small, cs, ` s${String(i)}x`));
    out['small_ms_from_edit_to_markdown_stored'] = smallRuns;
    out['small_saved'] = savedLines(small).slice(-1);

    const sizeKb = Number(process.env['BENCH_MARKDOWN_KB'] ?? '180');
    const big = newPage();
    const line = 'The quick brown fox jumps over the lazy dog, again and again, with *emphasis* and `code` and a [link](https://example.com).\n\n';
    const md = line.repeat(Math.ceil((sizeKb * 1024) / line.length));
    await devFixtures(DB);
    await insertPage((sql) => sqlAdmin(DB, sql), { collection_id: DEV_COLLECTION, id: big, markdown: md });
    const t0 = performance.now();
    const cb = await open(big);
    out['big_open_seed_ms'] = Math.round(performance.now() - t0);
    out['big_state_bytes'] = (await columnsOf(DB, big))?.ydoc_size;
    const bigRuns: number[] = [];
    for (let i = 0; i < 2; i++) bigRuns.push(await editAndMeasure(big, cb, ` b${String(i)}x`));
    out['big_ms_from_edit_to_markdown_stored'] = bigRuns;
    out['big_saved'] = savedLines(big).slice(-1);

    // Another page saves while the big page converts: edit big, 100 ms later edit small, time the small one.
    const overlap: number[] = [];
    for (let i = 0; i < 2; i++) {
      // The rejection of the big page's poll is caught at once (and rethrown below), so it is never an unhandled rejection while the small page is measured.
      const marker = ` o${String(i)}x`;
      const bigDone = editAndMeasure(big, cb, marker).then(() => undefined, (e: unknown) => ({ e }));
      await new Promise((r) => setTimeout(r, DEBOUNCE + 100)); // places the second edit about when the big page's save is converting
      // The overlap is shown by the database, read right before the second edit: the big page's row does not yet hold the first edit, so its conversion
      // or write is still pending when the small page's edit arrives. If it is already stored the sample is not the case this number names.
      const alreadyStored = (await columnsOf(DB, big))?.markdown?.includes(marker) === true;
      overlap.push(await editAndMeasure(small, cs, ` p${String(i)}x`));
      const failed = await bigDone;
      if (failed) throw failed.e;
      if (alreadyStored) throw new Error('the big page was already stored when the small page was edited: not an overlap');
    }
    out['small_ms_while_big_converts'] = overlap;
    out['convert_failed_lines'] = server.events.filter((e) => e['event'] === 'collab.convert_failed').map((e) => ({ kind: e['kind'], reason: e['reason'], detail: e['detail'] }));
    const file = process.env['BENCH_OUT'] ?? 'test-results/save-latency.json';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  });
});
