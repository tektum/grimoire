import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin, startServer } from '../server/support/harness.js';
import type { ServerProcess } from '../server/support/harness.js';
import { eventually, newPage, seedPage } from './support.js';
import { ALICE, BOB, appUrl, columnsOf, connectDoc, markdownOfState, stateOfMarkdown } from './m2-support.js';
import type { DocClient } from './m2-support.js';

const DB = 'grimoire_m2t04_save';
const fast = { GRIMOIRE_COLLAB_DEBOUNCE_MS: '300', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '1000', GRIMOIRE_COLLAB_STORE_RETRY_BASE_MS: '100', GRIMOIRE_COLLAB_STORE_RETRY_MAX_MS: '300' };
const running: ServerProcess[] = [];
const clients: DocClient[] = [];
const start = async (env: Record<string, string> = {}): Promise<ServerProcess> => { const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(DB), ...fast, ...env } }); running.push(s); return s; };
const open = (s: ServerProcess, page: string, user: string): DocClient => { const c = connectDoc(s.port, page, user); clients.push(c); return c; };
const events = (s: ServerProcess, name: string) => s.events.filter((e) => e['event'] === name);
const synced = (c: DocClient) => eventually(() => (c.provider.synced ? true : undefined), 5000, 'synced');
/** The first edit of an empty page applies the update of a seeded document; later edits append to its first paragraph (two seeded documents do not merge into one). */
const edit = async (c: DocClient, text: string): Promise<void> => {
  const fragment = c.doc.getXmlFragment('prosemirror');
  const paragraph = fragment.length === 0 ? undefined : fragment.get(0);
  const run = paragraph instanceof Y.XmlElement ? paragraph.get(0) : undefined;
  if (run instanceof Y.XmlText) run.insert(run.length, ` ${text}`);
  else Y.applyUpdate(c.doc, await stateOfMarkdown(text));
};

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); }, 60_000);
afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  await sqlAdmin(DB, 'grant update on pages to grimoire_app');
  await Promise.all(running.splice(0).map((s) => s.kill()));
});
afterAll(async () => { await dropTestDatabase(DB); });

describe('save columns', { timeout: 40_000 }, () => {
  it('after an edit the row has state, Markdown, text, the SHA-256 of title, NUL and Markdown, editor, edit time and a later updated_at, within 10 s', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const before = await columnsOf(DB, page);
    const c = open(s, page, ALICE); await synced(c);
    const t0 = Date.now();
    await edit(c, '# Title\n\nSome *text* here');
    const row = await eventually(async () => { const r = await columnsOf(DB, page); return r?.markdown ? r : undefined; }, 10_000, 'markdown stored');
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(row.markdown).toContain('Some *text* here');
    expect(row.text_content).toContain('Some text here');
    expect(row.markdown_hash?.byteLength).toBe(32);
    expect(Buffer.from(row.markdown_hash ?? '')).toEqual(createHash('sha256').update('', 'utf8').update('\0').update(row.markdown ?? '', 'utf8').digest());
    expect(row.ydoc).not.toBeNull();
    expect(row.ydoc_size).toBe(row.ydoc?.byteLength);
    expect(row.last_edited_by).toBe(ALICE);
    expect(row.last_edited_at).not.toBeNull();
    expect((row.updated_at) > (before?.updated_at ?? '')).toBe(true);
    expect(await markdownOfState(new Uint8Array(row.ydoc ?? []))).toBe(row.markdown);
  });

  it('a change the Markdown cannot show (text typed and deleted again) stores the state and leaves the Markdown columns as they were', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const c = open(s, page, ALICE); await synced(c);
    await edit(c, 'unchanged text');
    const first = await eventually(async () => { const r = await columnsOf(DB, page); return r?.markdown ? r : undefined; }, 10_000, 'stored');
    // A change that leaves the Markdown as it is (text typed and deleted again) makes Hocuspocus save again.
    const paragraph = c.doc.getXmlFragment('prosemirror').get(0);
    const run = paragraph instanceof Y.XmlElement ? paragraph.get(0) : undefined;
    if (!(run instanceof Y.XmlText)) throw new Error('no text run');
    const end = run.length;
    run.insert(end, 'zz');
    await eventually(() => (c.provider.hasUnsyncedChanges ? undefined : true), 5000, 'the insert reached the server'); // the delete must go out as its own update after the insert
    run.delete(end, 2);
    await eventually(async () => { const r = await columnsOf(DB, page); return r && !Buffer.from(r.ydoc ?? '').equals(Buffer.from(first.ydoc ?? '')) ? true : undefined; }, 10_000, 'state stored');
    const after = await columnsOf(DB, page);
    expect(after?.markdown).toBe(first.markdown);
    expect(Buffer.from(after?.markdown_hash ?? '')).toEqual(Buffer.from(first.markdown_hash ?? ''));
    expect((after?.updated_at ?? '') > first.updated_at).toBe(true);
  });

  it('two clients edit alternately: last_edited_by is the user whose update arrived last; a dev user without a seeded row is provisioned and recorded by its row id', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const a = open(s, page, ALICE); const b = open(s, page, BOB); await synced(a); await synced(b);
    await edit(a, 'from alice');
    await eventually(async () => ((await columnsOf(DB, page))?.last_edited_by === ALICE ? true : undefined), 10_000, 'alice');
    await edit(b, 'from bob');
    await eventually(async () => ((await columnsOf(DB, page))?.last_edited_by === BOB ? true : undefined), 10_000, 'bob');
    const page2 = newPage(); await seedPage(DB, page2);
    const d = open(s, page2, 'alice-not-a-uuid'); await synced(d);
    await edit(d, 'from a dev user');
    const row = await eventually(async () => { const r = await columnsOf(DB, page2); return r?.markdown ? r : undefined; }, 10_000, 'dev user text');
    // local mode provisions every dev subject: the column holds that row's id, never the token subject.
    const provisioned = (await sqlAdmin<{ id: string }>(DB, "select id::text from users where descope_user_id = 'alice-not-a-uuid'"))[0]?.id;
    expect(provisioned).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.last_edited_by).toBe(provisioned);
  });

  it('a state the converter cannot read is stored state-only: Markdown stays, convert_failed (broken) once, the edit is not lost', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const c = open(s, page, ALICE); await synced(c);
    await edit(c, 'good text');
    await eventually(async () => ((await columnsOf(DB, page))?.markdown ? true : undefined), 10_000, 'first save');
    const good = await columnsOf(DB, page);
    c.doc.getText('not-a-fragment').insert(0, 'live edit'); // a type the schema does not know: the converter refuses
    await eventually(() => (events(s, 'collab.convert_failed').length >= 1 ? true : undefined), 10_000, 'convert_failed');
    const failed = events(s, 'collab.convert_failed')[0];
    expect(failed).toMatchObject({ kind: 'broken' });
    await eventually(() => (events(s, 'collab.convert_alarm').length === 1 ? true : undefined), 5000, 'alarm');
    await eventually(async () => { const r = await columnsOf(DB, page); return r && r.updated_at > (good?.updated_at ?? '') ? true : undefined; }, 10_000, 'state stored');
    const row = await columnsOf(DB, page);
    expect(row?.markdown).toBe(good?.markdown);
    expect((await sqlAdmin<{ s: string | null }>(DB, `select markdown_stale_since::text as s from pages where id = '${page}'`))[0]?.s).not.toBeNull();
    expect(Buffer.from(row?.markdown_hash ?? '')).toEqual(Buffer.from(good?.markdown_hash ?? ''));
    const d = new Y.Doc(); Y.applyUpdate(d, new Uint8Array(row?.ydoc ?? []));
    expect(d.getText('not-a-fragment').toString()).toBe('live edit');
    expect(JSON.stringify(failed)).not.toContain('live edit');
  });

  it('a write that fails leaves every column unchanged and logs collab.store_failed, never page text', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const c = open(s, page, ALICE); await synced(c);
    await edit(c, 'first version');
    await eventually(async () => ((await columnsOf(DB, page))?.markdown ? true : undefined), 10_000, 'first save');
    const before = await columnsOf(DB, page);
    await sqlAdmin(DB, 'revoke update on pages from grimoire_app');
    await edit(c, 'second version');
    await eventually(() => (events(s, 'collab.store_failed').length >= 2 ? true : undefined), 10_000, 'failures');
    expect(await columnsOf(DB, page)).toEqual(before);
    expect(s.output).not.toMatch(/first version|second version/);
    await sqlAdmin(DB, 'grant update on pages to grimoire_app');
    const after = await eventually(async () => { const r = await columnsOf(DB, page); return r?.markdown?.includes('second version') ? r : undefined; }, 15_000, `stored after recovery: ${JSON.stringify((await columnsOf(DB, page))?.markdown)} ${s.output.slice(-1500)}`);
    expect(after.last_edited_by).toBe(ALICE);
  });

  it('SIGTERM inside the debounce window: the final save converts and the Markdown of the latest text is in the row', async () => {
    const s = await start({ GRIMOIRE_COLLAB_DEBOUNCE_MS: '30000', GRIMOIRE_COLLAB_MAX_DEBOUNCE_MS: '60000' });
    const page = newPage(); await seedPage(DB, page);
    const c = open(s, page, ALICE); await synced(c);
    await edit(c, 'typed just before shutdown');
    await eventually(() => (c.provider.hasUnsyncedChanges ? undefined : true), 5000, 'the server applied the edit'); // it acknowledges each applied update
    expect((await columnsOf(DB, page))?.markdown).toBeNull();
    s.signal('SIGTERM');
    const exit = await s.exited;
    expect(exit.code).toBe(0);
    expect((await columnsOf(DB, page))?.markdown).toContain('typed just before shutdown');
    expect(events(s, 'shutdown.hook_done').map((e) => e['hook'])).toEqual(expect.arrayContaining(['collab-save-pages', 'markdown-pool']));
  });

  it('F7: a trailing space the Markdown cannot show is stored: it is still there after a restart and a reload', async () => {
    const s = await start();
    const page = newPage(); await seedPage(DB, page);
    const c = open(s, page, ALICE); await synced(c);
    await edit(c, 'hello');
    const first = await eventually(async () => { const r = await columnsOf(DB, page); return r?.markdown ? r : undefined; }, 10_000, 'markdown stored');
    const runOf = (doc: Y.Doc): Y.XmlText => {
      const para = doc.getXmlFragment('prosemirror').get(0);
      const run = para instanceof Y.XmlElement ? para.get(0) : undefined;
      if (!(run instanceof Y.XmlText)) throw new Error('no text run');
      return run;
    };
    runOf(c.doc).insert(runOf(c.doc).length, ' ');
    const second = await eventually(async () => { const r = await columnsOf(DB, page); return r && !Buffer.from(r.ydoc ?? '').equals(Buffer.from(first.ydoc ?? '')) ? r : undefined; }, 10_000, 'state with the space stored');
    expect(second.markdown).toBe(first.markdown); // the Markdown is the same: that is the case
    c.destroy();
    await s.kill(); running.length = 0;
    const s2 = await start();
    const d = open(s2, page, ALICE); await synced(d);
    expect(runOf(d.doc).toString()).toMatch(/hello $/);
  });

  it('F7: opening and closing a page writes nothing (updated_at is untouched)', async () => {
    // One open document at a time makes an unload observable: another page loads only after this one has left memory, and Hocuspocus
    // unloads a page only once no store is pending or running, so its close-time store hooks have finished by then.
    const s = await start({ GRIMOIRE_COLLAB_MAX_OPEN_DOCUMENTS: '1' });
    const openWhenFree = (id: string, user: string): Promise<DocClient> => eventually(async () => {
      const client = open(s, id, user);
      const outcome = await eventually(() => (client.provider.synced ? 'synced' : client.failures.includes('documents-full') ? 'full' : undefined), 5000, 'synced or documents-full');
      if (outcome === 'synced') return client;
      client.destroy();
      return undefined;
    }, 10_000, `page ${id} opened`);
    const unloaded = async (): Promise<void> => { const probe = newPage(); await seedPage(DB, probe); (await openWhenFree(probe, ALICE)).destroy(); };
    const page = newPage(); await seedPage(DB, page);
    const c = open(s, page, ALICE); await synced(c);
    await edit(c, 'stable');
    const stored = await eventually(async () => { const r = await columnsOf(DB, page); return r?.markdown ? r : undefined; }, 10_000, 'stored');
    c.destroy();
    await unloaded();
    const d = await openWhenFree(page, BOB);
    await eventually(() => (d.provider.synced ? true : undefined), 5000, 'the page is open and synced'); // it was really open before it closes
    d.destroy();
    await unloaded();
    expect(await columnsOf(DB, page)).toEqual(stored); // against what was stored before the page was reopened, not against another read after it
    expect((await columnsOf(DB, page))?.updated_at).toBe(stored.updated_at);
  });
});
