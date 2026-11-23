import { randomUUID } from 'node:crypto';
import type { CreatePageResult, NewPage, PageLimits, PageMeta, PageRepo } from '../ports/page-repo.js';
import { emptyWorld } from './fake-access-store.js';
import type { World } from './fake-access-store.js';

interface Row extends PageMeta {
  readonly deleted: boolean;
  readonly markdown: string | null;
  readonly state: Uint8Array | null;
}

/** In-memory PageRepo for tests. Collections are the `World`'s (so a delete there is seen here); pages are mirrored into it. */
export class FakePageRepo implements PageRepo {
  private readonly rows: Row[] = [];
  /** Test setup: ran inside `create` after the collection check; a test deletes the collection here to play the race. */
  beforeInsert: (() => void) | undefined;

  constructor(readonly world: World = emptyWorld()) {}

  /** What was stored for a page (Markdown and state), or undefined. */
  stored(id: string): { markdown: string | null; state: Uint8Array | null } | undefined {
    const row = this.rows.find((r) => r.id === id);
    return row === undefined ? undefined : { markdown: row.markdown, state: row.state };
  }

  count(): number {
    return this.rows.length;
  }

  /** Test setup: a live page, also a fact of the world. */
  seed(page: Partial<PageMeta> & { collectionId: string }): PageMeta {
    const id = page.id ?? randomUUID();
    const meta: PageMeta = {
      id, urlId: page.urlId ?? id.slice(0, 8), collectionId: page.collectionId, parentId: page.parentId ?? null,
      position: page.position ?? `p${String(this.rows.length).padStart(5, '0')}`, title: page.title ?? '', icon: page.icon ?? null,
      createdBy: page.createdBy ?? randomUUID(), lastEditedBy: null, lastEditedAt: null, savedAt: 0, stateEpoch: 0,
    };
    this.rows.push({ ...meta, deleted: false, markdown: null, state: null });
    this.world.pages.push({ id, collectionId: page.collectionId, deleted: false, epoch: 0 });
    return meta;
  }

  create(input: NewPage, limits: PageLimits, position: (before: string | null, after: string | null) => string): Promise<CreatePageResult> {
    const collection = this.world.collections.find((c) => c.id === input.collectionId);
    if (collection === undefined || collection.deleted) return Promise.resolve({ kind: 'collection-deleted' });
    this.beforeInsert?.();
    if (this.world.collections.find((c) => c.id === input.collectionId)?.deleted === true) return Promise.resolve({ kind: 'collection-deleted' });
    const live = this.rows.filter((r) => !r.deleted && r.collectionId === input.collectionId);
    const parent = input.parentId === null ? undefined : live.find((r) => r.id === input.parentId);
    if (input.parentId !== null && parent === undefined) return Promise.resolve({ kind: 'no-parent' });
    const siblings = live.filter((r) => r.parentId === input.parentId).sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    const after = input.afterId === null ? undefined : siblings.find((r) => r.id === input.afterId);
    if (input.afterId !== null && after === undefined) return Promise.resolve({ kind: 'no-after' });
    let depth = 1;
    for (let up = parent; up !== undefined; up = live.find((r) => r.id === up?.parentId)) depth += 1;
    if (depth > limits.maxDepth) return Promise.resolve({ kind: 'too-deep' });
    if (live.length >= limits.maxPages) return Promise.resolve({ kind: 'collection-full' });
    const before = after === undefined ? (siblings.at(-1)?.position ?? null) : after.position;
    const next = after === undefined ? null : (siblings[siblings.indexOf(after) + 1]?.position ?? null);
    const page = this.seed({ collectionId: input.collectionId, parentId: input.parentId, title: input.title, createdBy: input.createdBy, position: position(before, next) });
    const row = this.rows.find((r) => r.id === page.id) as Row;
    this.rows[this.rows.indexOf(row)] = { ...row, markdown: input.content?.markdown ?? null, state: input.content?.state ?? null };
    return Promise.resolve({ kind: 'created', page });
  }
}
