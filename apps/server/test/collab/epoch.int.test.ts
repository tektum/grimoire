import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { eventually, newPage, seedPage, sleep } from './support.js';
import { ALICE, BOB, appUrl, columnsOf, connectDoc, stateOfMarkdown } from './m2-support.js';
import type { DocClient } from './m2-support.js';

const DB = 'grimoire_m2t06_epoch';
const fast = { GRIMOIRE_COLLAB_DEBOUNCE_MS: '300', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '1000', GRIMOIRE_COLLAB_STORE_RETRY_BASE_MS: '100', GRIMOIRE_COLLAB_STORE_RETRY_MAX_MS: '300' };
const running: ServerProcess[] = [];
const clients: DocClient[] = [];
const start = async (): Promise<ServerProcess> => { const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), ...fast } }); running.push(s); return s; };
const open = (s: ServerProcess, page: string, user: string): DocClient => { const c = connectDoc(s.port, page, user); clients.push(c); return c; };
const events = (s: ServerProcess, name: string) => s.events.filter((e) => e['event'] === name);
const synced = (c: DocClient) => eventually(() => (c.provider.synced ? true : undefined), 5000, 'synced');
const edit = async (c: DocClient, text: string): Promise<void> => {
  const fragment = c.doc.getXmlFragment('prosemirror');
  const paragraph = fragment.length === 0 ? undefined : fragment.get(0);
  const run = paragraph instanceof Y.XmlElement ? paragraph.get(0) : undefined;
  if (run instanceof Y.XmlText) run.insert(run.length, ` ${text}`);
  else Y.applyUpdate(c.doc, await stateOfMarkdown(text));
};
/** A page with a stored first edit and a connected client, ready for the epoch to move. */
const storedPage = async (s: ServerProcess) => {
  const page = newPage(); await seedPage(DB, page);
  const c = open(s, page, ALICE); await synced(c);
  await edit(c, 'first text');
  await eventually(async () => ((await columnsOf(DB, page))?.markdown ? true : undefined), 10_000, 'first save');
  return { page, c };
};

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  await Promise.all(running.splice(0).map((s) => s.kill()));
});
afterAll(async () => { await dropTestDatabase(DB); });

describe('epoch-checked saves', { timeout: 40_000 }, () => {
  it('a bumped epoch: the next save writes nothing, one collab.save_refused_epoch, no collab.store_failed, the connection is closed', async () => {
    const s = await start();
    const { page, c } = await storedPage(s);
    await sqlAdmin(DB, `update pages set state_epoch = state_epoch + 1 where id = '${page}'`);
    const before = await columnsOf(DB, page);
    const closedBefore = c.closes.length;
    await edit(c, 'second text');
    await eventually(() => (events(s, 'collab.save_refused_epoch').length > 0 ? true : undefined), 10_000, 'refused');
    await eventually(() => (c.closes.length > closedBefore ? true : undefined), 10_000, 'connection closed');
    c.destroy();
    await sleep(250); // 2.5 store retry delays (100 ms): a retry would show as store_failed
    const after = await columnsOf(DB, page);
    expect(after?.ydoc).toEqual(before?.ydoc);
    expect(after?.markdown).toBe(before?.markdown);
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(events(s, 'collab.save_refused_epoch')).toHaveLength(1);
    expect(events(s, 'collab.store_failed')).toHaveLength(0);
  });

  it('afterwards a new client loads the new epoch and its edit is saved', async () => {
    const s = await start();
    const { page, c } = await storedPage(s);
    await sqlAdmin(DB, `update pages set state_epoch = state_epoch + 1 where id = '${page}'`);
    const before = await columnsOf(DB, page);
    await edit(c, 'second text');
    await eventually(() => (events(s, 'collab.save_refused_epoch').length > 0 ? true : undefined), 10_000, 'refused');
    c.destroy();
    await sleep(250);
    const fresh = open(s, page, BOB); await synced(fresh);
    await edit(fresh, 'third text');
    const row = await eventually(async () => { const r = await columnsOf(DB, page); return r !== undefined && r.updated_at > (before?.updated_at ?? '') ? r : undefined; }, 10_000, 'saved at the new epoch');
    expect(row.markdown).toContain('third text');
    expect(events(s, 'collab.save_refused_epoch')).toHaveLength(1);
  });

  it('a deleted row: the next save is refused and logged, the connection closed, no retry', async () => {
    const s = await start();
    const { page, c } = await storedPage(s);
    await sqlAdmin(DB, `delete from pages where id = '${page}'`);
    const closedBefore = c.closes.length;
    await edit(c, 'second text');
    await eventually(() => (events(s, 'collab.save_refused_epoch').length > 0 ? true : undefined), 10_000, 'refused');
    await eventually(() => (c.closes.length > closedBefore ? true : undefined), 10_000, 'connection closed');
    c.destroy();
    await sleep(250);
    expect(events(s, 'collab.save_refused_epoch')).toHaveLength(1);
    expect(events(s, 'collab.save_refused_epoch')[0]?.['reason']).toBe('no-row');
    expect(events(s, 'collab.store_failed')).toHaveLength(0);
  });
});
