import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSeedRefusal, seedUserMarkdown } from '@tektum/grimoire-core/pages/seeded-content';
import type { PageLimits } from '@tektum/grimoire-core/ports/page-repo';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { createPages } from '../../src/pages.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let user: string;
let collection: string;
const ordering = new FakeOrdering();
const limits: PageLimits = { maxDepth: 32, maxPages: 10_000 };
const pages = () => createPages(t.app);

async function make(title: string, markdown?: string): Promise<string> {
  let content;
  if (markdown !== undefined) {
    const converter = new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array([1, 2, 3]) }, convert: { ok: true, markdown, text: markdown } });
    const seeded = await seedUserMarkdown(converter, user, title, markdown);
    if (isSeedRefusal(seeded)) throw new Error('refused');
    content = seeded;
  }
  const r = await pages().create({ collectionId: collection, parentId: null, afterId: null, title, createdBy: user, content }, limits, (a, b) => ordering.between(a, b));
  if (r.kind !== 'created') throw new Error(r.kind);
  return r.page.id;
}

beforeAll(async () => {
  t = await createTestDatabase('markdownof');
  user = await addUser(t.app, 'ada', 'admin');
  collection = (await createCollections(t.app).append({ name: 'md', createdBy: user }, (last) => ordering.between(last, null))).id;
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('PageRepo.markdownOf', () => {
  it('returns the stored Markdown and says the row has a state, for a page made from Markdown', async () => {
    const id = await make('From text', '# Hello\n\nworld\n');
    expect(await pages().markdownOf(id)).toEqual({ markdown: '# Hello\n\nworld\n', hasState: true });
  });

  it('returns no Markdown and no state for a page made without content', async () => {
    const id = await make('Empty');
    expect(await pages().markdownOf(id)).toEqual({ markdown: null, hasState: false });
  });

  it('returns a state without Markdown when only the state is stored', async () => {
    const id = await make('State only');
    await t.admin.query(`update pages set ydoc = '\\x0102', markdown = null where id = $1`, [id]);
    expect(await pages().markdownOf(id)).toEqual({ markdown: null, hasState: true });
  });

  it('is undefined for an unknown page, a deleted page and a page of a deleted collection', async () => {
    expect(await pages().markdownOf('00000000-0000-4000-8000-000000000999')).toBeUndefined();
    const gone = await make('Gone', 'x');
    await t.admin.query(`update pages set deleted_at = now() where id = $1`, [gone]);
    expect(await pages().markdownOf(gone)).toBeUndefined();
    const other = (await createCollections(t.app).append({ name: 'md2', createdBy: user }, (last) => ordering.between(last, null))).id;
    const r = await pages().create({ collectionId: other, parentId: null, afterId: null, title: 'In other', createdBy: user }, limits, (a, b) => ordering.between(a, b));
    if (r.kind !== 'created') throw new Error(r.kind);
    await t.admin.query(`update collections set deleted_at = now() where id = $1`, [other]);
    expect(await pages().markdownOf(r.page.id)).toBeUndefined();
  });
});
