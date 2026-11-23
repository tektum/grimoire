import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { insertPage } from '@tektum/grimoire-test-support/database';
import { createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { eventually, DEV_COLLECTION, devFixtures, newPage } from './support.js';
import { ALICE, appUrl, columnsOf, connectDoc, markdownOfState, stateOfMarkdown } from './m2-support.js';
import type { DocClient } from './m2-support.js';

const DB = 'grimoire_m2t04_seed';
const running: ServerProcess[] = [];
const clients: DocClient[] = [];
const MD = '# Imported\n\nA paragraph with **bold** and a list:\n\n- one\n- two\n';

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterEach(async () => { clients.splice(0).forEach((c) => { c.destroy(); }); await Promise.all(running.splice(0).map((s) => s.kill())); });
afterAll(async () => { await dropTestDatabase(DB); });

const start = async (): Promise<ServerProcess> => { const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB) } }); running.push(s); return s; };

describe('seeding from Markdown', () => {
  it('a row with Markdown and a null state opens, and the client document converts to the canonical Markdown of that row', async () => {
    const s = await start();
    const page = newPage();
    await devFixtures(DB);
    await insertPage((sql) => sqlAdmin(DB, sql), { collection_id: DEV_COLLECTION, id: page, markdown: MD });
    const c = connectDoc(s.port, page, ALICE); clients.push(c);
    await eventually(() => (c.provider.synced ? true : undefined), 10_000, 'synced');
    const row = await columnsOf(DB, page);
    expect(row?.ydoc).not.toBeNull();
    const canonical = await markdownOfState(Y.encodeStateAsUpdate(c.doc));
    expect(canonical).toBe(await markdownOfState(new Uint8Array(row?.ydoc ?? [])));
    expect(canonical).toBe(await markdownOfState(await stateOfMarkdown(MD)));
    expect(canonical).toContain('**bold**');
  });

  it('20 clients opening one unseeded page at once give exactly one collab.seed log line for it', async () => {
    const s = await start();
    const page = newPage();
    await devFixtures(DB);
    await insertPage((sql) => sqlAdmin(DB, sql), { collection_id: DEV_COLLECTION, id: page, markdown: MD });
    const many = Array.from({ length: 20 }, () => connectDoc(s.port, page, ALICE));
    clients.push(...many);
    await eventually(() => (many.every((c) => c.provider.synced) ? true : undefined), 15_000, 'all synced');
    expect(s.events.filter((e) => e['event'] === 'collab.seed' && e['pageId'] === page)).toHaveLength(1);
    const texts = new Set(await Promise.all(many.map((c) => markdownOfState(Y.encodeStateAsUpdate(c.doc)))));
    expect(texts.size).toBe(1);
  }, 30_000);

  it('a page whose Markdown the converter refuses is refused as seed-failed and logs collab.seed_failed', async () => {
    const s = await start();
    const page = newPage();
    await devFixtures(DB);
    await insertPage((sql) => sqlAdmin(DB, sql), { collection_id: DEV_COLLECTION, id: page, markdown: '<' + 'a'.repeat(2_000_000) });
    const c = connectDoc(s.port, page, ALICE); clients.push(c);
    await eventually(() => (c.failures.length > 0 ? true : undefined), 15_000, 'refused');
    expect(c.failures[0]).toBe('seed-failed');
    expect(s.events.filter((e) => e['event'] === 'collab.seed_failed' && e['pageId'] === page)).toHaveLength(1);
    expect((await columnsOf(DB, page))?.ydoc).toBeNull();
    // the client reconnects on its own: the repeats are refused cheaply and the log stays quiet (throttled: one line per window)
    await eventually(() => (c.failures.length >= 3 ? true : undefined), 15_000, 'two more refused reconnects');
    expect(c.failures.every((f) => f === 'seed-failed')).toBe(true);
    expect(s.events.filter((e) => e['event'] === 'collab.seed_failed' && e['pageId'] === page).length).toBeLessThanOrEqual(1);
  }, 30_000);
});
