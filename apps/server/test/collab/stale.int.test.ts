import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { eventually, DEV_COLLECTION, devFixtures, newPage, sleep } from './support.js';
import { ALICE, appUrl, columnsOf, connectDoc, stateOfMarkdown } from './m2-support.js';
import type { DocClient } from './m2-support.js';

const DB = 'grimoire_m2t04_stale';
const running: ServerProcess[] = [];
const clients: DocClient[] = [];
const start = async (): Promise<ServerProcess> => { const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), GRIMOIRE_COLLAB_DEBOUNCE_MS: '300' } }); running.push(s); return s; };
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const staleSince = async (id: string) => (await sqlAdmin<{ s: string | null }>(DB, `select markdown_stale_since::text as s from pages where id = '${id}'`))[0]?.s;

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterEach(async () => { clients.splice(0).forEach((c) => { c.destroy(); }); await Promise.all(running.splice(0).map((s) => s.kill())); });
afterAll(async () => { await dropTestDatabase(DB); });

describe('stale Markdown (fix round, item 2)', { timeout: 40_000 }, () => {
  it('a stale row survives a server restart; opening the page on the new process converts it without an edit and clears the mark', async () => {
    const page = newPage();
    await devFixtures(DB);
    await sqlAdmin(DB, `insert into pages (collection_id, id, ydoc, markdown, markdown_stale_since) values ('${DEV_COLLECTION}', '${page}', '\\x${hex(await stateOfMarkdown('fresh words'))}', 'old words', now())`);
    const first = await start();
    await first.kill(); running.length = 0; // a restart: nothing is held in memory
    expect(await staleSince(page)).not.toBeNull();
    expect((await columnsOf(DB, page))?.markdown).toBe('old words');
    const s = await start();
    const c = connectDoc(s.port, page, ALICE); clients.push(c);
    await eventually(async () => ((await columnsOf(DB, page))?.markdown?.includes('fresh words') ? true : undefined), 15_000, 'converted on load');
    expect(await staleSince(page)).toBeNull();
  });

  it('a page whose conversion is refused is converted once per load, not in a loop, and stays marked', async () => {
    const page = newPage();
    const d = new Y.Doc(); d.getText('not-a-fragment').insert(0, 'unreadable');
    await devFixtures(DB);
    await sqlAdmin(DB, `insert into pages (collection_id, id, ydoc, markdown, markdown_stale_since) values ('${DEV_COLLECTION}', '${page}', '\\x${hex(Y.encodeStateAsUpdate(d))}', 'kept', now())`);
    const s = await start();
    const c = connectDoc(s.port, page, ALICE); clients.push(c);
    await eventually(() => (s.events.filter((e) => e['event'] === 'collab.convert_failed').length >= 1 ? true : undefined), 15_000, 'one attempt');
    await sleep(2500);
    expect(s.events.filter((e) => e['event'] === 'collab.convert_failed')).toHaveLength(1);
    expect((await columnsOf(DB, page))?.markdown).toBe('kept');
    expect(await staleSince(page)).not.toBeNull();
  });
});
