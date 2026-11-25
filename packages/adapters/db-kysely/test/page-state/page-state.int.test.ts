import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '@tektum/grimoire-test-support/harness';
import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import { isSeedRefusal, seedUserMarkdown } from '@tektum/grimoire-core/pages/seeded-content';
import type { SeededContent } from '@tektum/grimoire-core/pages/seeded-content';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { createPages } from '../../src/pages.js';
import { createPageState } from '../../src/page-state.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let admin: string;
let collectionId: string;
const ordering = new FakeOrdering();
const between = (before: string | null, after: string | null): string => ordering.between(before, after);

const seeded = async (markdown: string, state = new Uint8Array([1, 2, 3, 4])): Promise<SeededContent> => {
  const converter = new FakeMarkdownConverter({ seed: { ok: true, state }, convert: { ok: true, markdown: `canonical ${markdown}`, text: `text ${markdown}` } });
  const result = await seedUserMarkdown(converter, admin, 'Doc', markdown);
  if (isSeedRefusal(result)) throw new Error(result.detail);
  return result;
};

/** A page with Markdown and a saved state. */
async function makePage(markdown = 'first'): Promise<string> {
  const made = await createPages(t.app).create('legacy', { collectionId, parentId: null, afterId: null, title: 'Doc', createdBy: admin, content: await seeded(markdown) }, { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 }, between);
  if (made.kind !== 'created') throw new Error(made.kind);
  return made.page.id;
}

interface PageRow { ydoc: Buffer | null; ydoc_size: number | null; state_epoch: number; markdown: string | null; text_content: string | null; markdown_hash: Buffer | null; stale: boolean }
const row = async (id: string): Promise<PageRow> =>
  (await t.admin.query<PageRow>(`select ydoc, ydoc_size, state_epoch, markdown, text_content, markdown_hash, markdown_stale_since is not null as stale from pages where id = $1`, [id]))[0] as PageRow;
const audits = (id: string) => t.admin.query<{ actor_id: string; detail: Record<string, unknown> }>(`select actor_id, detail from audit_events where action = 'page.state_reset' and target_id = $1`, [id]);

beforeAll(async () => {
  t = await createTestDatabase('pagestate');
  admin = await addUser(t.app, 'ada', 'admin');
  collectionId = (await createCollections(t.app).append('legacy', { name: 'Docs', createdBy: admin }, (last) => ordering.between(last, null))).id;
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL PageStateRepo', () => {
  it('counts a page with a state and no Markdown as stale, so a reset cannot empty it unconfirmed', async () => {
    const id = await makePage('only state');
    await t.admin.query(`update pages set markdown = null, text_content = null, markdown_hash = null where id = $1`, [id]);
    const before = await row(id);
    const repo = createPageState(t.app);
    expect(await repo.reset({ pageId: id, actorId: admin, confirmStale: false })).toEqual({ kind: 'stale-unconfirmed' });
    expect(await row(id)).toEqual(before);
    expect(await repo.reset({ pageId: id, actorId: admin, confirmStale: true })).toMatchObject({ kind: 'reset', markdownStale: true });
  });

  it('refuses an actor who is no longer an active administrator when the transaction runs, and changes nothing', async () => {
    const id = await makePage('guarded');
    const before = await row(id);
    const demoted = await addUser(t.app, 'demoted', 'admin');
    const suspended = await addUser(t.app, 'suspended', 'admin');
    await t.admin.query(`update users set role = 'member' where id = $1`, [demoted]);
    await t.admin.query(`update users set suspended_at = now() where id = $1`, [suspended]);
    const repo = createPageState(t.app);
    for (const actorId of [demoted, suspended, '00000000-0000-4000-8000-000000000000']) {
      expect(await repo.reset({ pageId: id, actorId, confirmStale: true })).toEqual({ kind: 'not-admin' });
    }
    expect(await row(id)).toEqual(before);
    expect(await audits(id)).toEqual([]);
  });

  it('waits for a demotion that holds the actor row, then refuses', async () => {
    const id = await makePage('race');
    const actor = await addUser(t.app, 'racer', 'admin');
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = (): void => undefined;
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const demotion = t.admin.transaction(async (tx) => {
      await tx.query(`update users set role = 'member' where id = $1`, [actor]);
      held();
      await gate;
    });
    await locked;
    const reset = createPageState(t.app).reset({ pageId: id, actorId: actor, confirmStale: true });
    await eventually(async () => ((await t.admin.query<{ n: number }>(`select count(*)::int as n from pg_locks l where not l.granted and l.pid in (select pid from pg_stat_activity where datname = current_database())`))[0]?.n ?? 0) >= 1, 10_000, 'the reset waiting on the actor row');
    release();
    await demotion;
    expect(await reset).toEqual({ kind: 'not-admin' });
    expect(await audits(id)).toEqual([]);
  });

  it('without Markdown drops the state, bumps the epoch once, keeps the Markdown, and writes one audit row', async () => {
    const id = await makePage('keep me');
    const before = await row(id);
    const result = await createPageState(t.app).reset({ pageId: id, actorId: admin, confirmStale: false });
    expect(result).toEqual({ kind: 'reset', stateEpoch: before.state_epoch + 1, markdownStale: false });
    const after = await row(id);
    expect(after).toMatchObject({ ydoc: null, ydoc_size: null, state_epoch: before.state_epoch + 1, markdown: before.markdown, text_content: before.text_content });
    expect(after.markdown_hash?.equals(before.markdown_hash as Buffer)).toBe(true);
    expect((await audits(id)).map((a) => [a.actor_id, a.detail])).toEqual([[admin, { stateEpoch: before.state_epoch + 1, markdownReplaced: false, markdownStale: false }]]);
  });

  it('with supplied Markdown stores the state with the Markdown, search text and hash together, never Markdown without state', async () => {
    const id = await makePage('old');
    const content = await seeded('replacement', new Uint8Array([7, 7, 7]));
    const result = await createPageState(t.app).reset({ pageId: id, actorId: admin, content, confirmStale: false });
    expect(result).toMatchObject({ kind: 'reset', markdownStale: false });
    const after = await row(id);
    expect([...(after.ydoc as Buffer)]).toEqual([7, 7, 7]);
    expect(after).toMatchObject({ ydoc_size: 3, markdown: 'canonical replacement', text_content: 'text replacement' });
    expect(after.markdown_hash?.equals(markdownHash('Doc', 'canonical replacement'))).toBe(true);
    expect((await t.admin.query<{ n: number }>(`select count(*)::int as n from pages where id = $1 and markdown is not null and ydoc is null`, [id]))[0]?.n).toBe(0);
    expect((await audits(id)).map((a) => a.detail)).toEqual([expect.objectContaining({ markdownReplaced: true })]);
  });

  it('refuses a replacement without state in the same statement, and nothing changes: epoch, state, Markdown, audit', async () => {
    const id = await makePage('stay');
    const before = await row(id);
    const empty = await seeded('x', new Uint8Array(0));
    expect(await createPageState(t.app).reset({ pageId: id, actorId: admin, content: empty, confirmStale: false })).toEqual({ kind: 'empty-state' });
    expect(await row(id)).toEqual(before);
    expect(await audits(id)).toEqual([]);
  });

  it('asks for confirmation on a page whose Markdown is older than its state, changes nothing until it is given, and clears the mark', async () => {
    const id = await makePage('behind');
    await t.admin.query(`update pages set markdown_stale_since = now() where id = $1`, [id]);
    const before = await row(id);
    const repo = createPageState(t.app);
    expect(await repo.reset({ pageId: id, actorId: admin, confirmStale: false })).toEqual({ kind: 'stale-unconfirmed' });
    expect(await row(id)).toEqual(before);
    expect(await audits(id)).toEqual([]);
    expect(await repo.reset({ pageId: id, actorId: admin, confirmStale: true })).toEqual({ kind: 'reset', stateEpoch: before.state_epoch + 1, markdownStale: true });
    expect(await row(id)).toMatchObject({ ydoc: null, stale: false });
    expect((await audits(id)).map((a) => a.detail)).toEqual([expect.objectContaining({ markdownStale: true })]);
  });

  it('needs no confirmation when the Markdown is replaced, even on a stale page', async () => {
    const id = await makePage('behind');
    await t.admin.query(`update pages set markdown_stale_since = now() where id = $1`, [id]);
    const result = await createPageState(t.app).reset({ pageId: id, actorId: admin, content: await seeded('fresh'), confirmStale: false });
    expect(result).toMatchObject({ kind: 'reset', markdownStale: false });
    expect(await row(id)).toMatchObject({ stale: false, markdown: 'canonical fresh' });
  });

  it('does not find a deleted page, a page in a deleted collection, or an unknown id', async () => {
    const gone = await makePage('gone');
    await t.admin.query(`update pages set deleted_at = now() where id = $1`, [gone]);
    const other = (await createCollections(t.app).append('legacy', { name: 'Other', createdBy: admin }, (last) => ordering.between(last, null))).id;
    const inOther = (await createPages(t.app).create('legacy', { collectionId: other, parentId: null, afterId: null, title: 'T', createdBy: admin, content: await seeded('o') }, { maxDepth: 32, maxPages: 10, maxTenantPages: 50_000 }, between));
    if (inOther.kind !== 'created') throw new Error(inOther.kind);
    await t.admin.query(`update collections set deleted_at = now() where id = $1`, [other]);
    const repo = createPageState(t.app);
    for (const pageId of [gone, inOther.page.id, '00000000-0000-4000-8000-000000000000']) {
      expect(await repo.reset({ pageId, actorId: admin, confirmStale: true })).toEqual({ kind: 'not-found' });
    }
    expect(await audits(gone)).toEqual([]);
  });

  it('is one transaction: a failure after the audit insert leaves the page as it was', async () => {
    const id = await makePage('atomic');
    const before = await row(id);
    await t.admin.query(`create function refuse_audit() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`);
    await t.admin.query(`create trigger refuse_audit_trg after insert on audit_events for each row execute function refuse_audit()`);
    try {
      await expect(createPageState(t.app).reset({ pageId: id, actorId: admin, content: await seeded('lost'), confirmStale: false })).rejects.toThrow();
    } finally {
      await t.admin.query(`drop trigger refuse_audit_trg on audit_events`);
      await t.admin.query(`drop function refuse_audit()`);
    }
    expect(await row(id)).toEqual(before);
    expect(await audits(id)).toEqual([]);
  });

  it('serialises two resets of the same page: the epochs are consecutive and both are recorded', async () => {
    const id = await makePage('twice');
    const start = (await row(id)).state_epoch;
    const repo = createPageState(t.app);
    const results = await Promise.all([repo.reset({ pageId: id, actorId: admin, confirmStale: false }), repo.reset({ pageId: id, actorId: admin, confirmStale: false })]);
    expect(results.map((r) => (r.kind === 'reset' ? r.stateEpoch : -1)).sort()).toEqual([start + 1, start + 2]);
    expect(await audits(id)).toHaveLength(2);
  });
});
