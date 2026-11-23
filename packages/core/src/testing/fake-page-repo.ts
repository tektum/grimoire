import { randomUUID } from 'node:crypto';
import { markdownHash } from '../pages/hash.js';
import { checkMove, forestOf } from '../tree/move.js';
import type { CreatePageResult, NewPage, PageDetail, MovePageResult, PageLimits, PageMeta, PageMetaPatch, PageMove, PageRepo } from '../ports/page-repo.js';
import { emptyWorld } from './fake-access-store.js';
import type { World } from './fake-access-store.js';

interface Row extends PageMeta {
  readonly deleted: boolean;
  readonly markdown: string | null;
  readonly state: Uint8Array | null;
  readonly hash: Buffer | null;
  readonly staleSince: number | null;
  readonly batch?: string | null;
  readonly deletedBy?: string | null;
}

/** In-memory PageRepo for tests. Collections are the `World`'s (so a delete there is seen here); pages are mirrored into it. */
export class FakePageRepo implements PageRepo {
  private readonly rows: Row[] = [];
  /** The batch a deleted page carries, or undefined when it is not deleted (or unknown). */
  batchOf(id: string): string | null | undefined {
    const row = this.rows.find((r) => r.id === id);
    return row?.deleted === true ? (row.batch ?? null) : undefined;
  }

  /** Test setup: ran inside `create` after the collection check; a test deletes the collection here to play the race. */
  beforeInsert: (() => void) | undefined;

  constructor(readonly world: World = emptyWorld()) {}

  /** What was stored for a page (Markdown and state), or undefined. */
  stored(id: string): { markdown: string | null; state: Uint8Array | null; hash: Buffer | null } | undefined {
    const row = this.rows.find((r) => r.id === id);
    return row === undefined ? undefined : { markdown: row.markdown, state: row.state, hash: row.hash };
  }

  count(): number {
    return this.rows.length;
  }

  /** Test setup: a live page, also a fact of the world. */
  seed(page: Partial<PageMeta> & { collectionId: string; markdown?: string; markdownStaleSince?: number }): PageMeta {
    const id = page.id ?? randomUUID();
    const meta: PageMeta = {
      id, urlId: page.urlId ?? id.slice(0, 8), collectionId: page.collectionId, parentId: page.parentId ?? null,
      position: page.position ?? `p${String(this.rows.length).padStart(5, '0')}`, title: page.title ?? '', icon: page.icon ?? null,
      createdBy: page.createdBy ?? randomUUID(), lastEditedBy: null, lastEditedAt: null, savedAt: 0, stateEpoch: 0,
    };
    const title = meta.title;
    this.rows.push({
      ...meta, deleted: false, markdown: page.markdown ?? null, state: null,
      hash: page.markdown === undefined ? null : markdownHash(title, page.markdown), staleSince: page.markdownStaleSince ?? null,
    });
    this.world.pages.push({ id, collectionId: page.collectionId, deleted: false, epoch: 0 });
    return meta;
  }

  create(input: NewPage, limits: PageLimits, position: (before: string | null, after: string | null) => string): Promise<CreatePageResult> {
    const collection = this.world.collections.find((c) => c.id === input.collectionId);
    if (collection === undefined || collection.deleted) return Promise.resolve({ kind: 'collection-deleted' });
    this.beforeInsert?.();
    if (this.world.collections.find((c) => c.id === input.collectionId)?.deleted === true) return Promise.resolve({ kind: 'collection-deleted' });
    if (input.content !== undefined && input.content.state.length === 0) throw new Error('the editor state of a page with Markdown cannot be empty');
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
    this.rows[this.rows.indexOf(row)] = { ...row, markdown: input.content?.markdown ?? null, state: input.content?.state ?? null, hash: input.content?.hash ?? null };
    return Promise.resolve({ kind: 'created', page });
  }

  move(id: string, to: PageMove, limits: PageLimits, position: (before: string | null, after: string | null) => string): Promise<MovePageResult> {
    const row = this.livePage(id);
    if (row === undefined) return Promise.resolve({ kind: 'not-found' });
    if (row.collectionId !== to.expectedCollectionId) return Promise.resolve({ kind: 'conflict' });
    const target = to.collectionId ?? row.collectionId;
    const collection = this.world.collections.find((c) => c.id === target);
    if (collection === undefined || collection.deleted) return Promise.resolve({ kind: 'collection-deleted' });
    const inTarget = this.rows.filter((r) => !r.deleted && r.collectionId === target);
    const parent = to.parentId === null ? undefined : inTarget.find((r) => r.id === to.parentId);
    if (to.parentId !== null && parent === undefined) return Promise.resolve({ kind: 'no-parent' });
    // The forest of this collection and the moved page's own, so the rules see exactly what the subtree brings along.
    const live = this.rows.filter((r) => !r.deleted && (r.collectionId === target || r.collectionId === row.collectionId));
    const check = checkMove(forestOf(live), { id, newParent: to.parentId, maxDepth: limits.maxDepth });
    if (check === 'would-create-cycle') return Promise.resolve({ kind: 'would-create-cycle' });
    if (check === 'too-deep') return Promise.resolve({ kind: 'too-deep' });
    const subtree = this.subtree(id);
    const liveSubtree = subtree.filter((r) => !r.deleted);
    if (target !== row.collectionId && inTarget.length + liveSubtree.length > limits.maxPages) return Promise.resolve({ kind: 'collection-full' });
    const siblings = inTarget.filter((r) => r.parentId === to.parentId && r.id !== id).sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    const after = to.afterId === null ? undefined : siblings.find((r) => r.id === to.afterId);
    if (to.afterId !== null && after === undefined) return Promise.resolve({ kind: 'no-after' });
    const before = after === undefined ? (siblings.at(-1)?.position ?? null) : after.position;
    const next = after === undefined ? null : (siblings[siblings.indexOf(after) + 1]?.position ?? null);
    const moved: Row = { ...row, collectionId: target, parentId: to.parentId, position: position(before, next) };
    for (const r of subtree) {
      const at = this.rows.indexOf(r);
      this.rows[at] = r.id === id ? moved : { ...r, collectionId: target };
      const fact = this.world.pages.find((w) => w.id === r.id);
      if (fact !== undefined) fact.collectionId = target;
    }
    return Promise.resolve({ kind: 'moved', page: this.meta(moved) });
  }

  softDelete(id: string, deletedBy: string): Promise<number | undefined> {
    const row = this.livePage(id);
    if (row === undefined) return Promise.resolve(undefined);
    const live = this.subtree(id).filter((r) => !r.deleted);
    for (const r of live) {
      this.rows[this.rows.indexOf(r)] = { ...r, deleted: true, batch: id, deletedBy };
      const fact = this.world.pages.find((w) => w.id === r.id);
      if (fact !== undefined) fact.deleted = true;
    }
    return Promise.resolve(live.length);
  }

  /** The page and every descendant, deleted ones included. */
  private subtree(id: string): Row[] {
    const out: Row[] = [];
    const queue = [id];
    for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
      const row = this.rows.find((r) => r.id === at);
      if (row !== undefined && !out.includes(row)) {
        out.push(row);
        queue.push(...this.rows.filter((r) => r.parentId === at).map((r) => r.id));
      }
    }
    return out;
  }

  private livePage(id: string): Row | undefined {
    const row = this.rows.find((r) => r.id === id && !r.deleted);
    const collection = row === undefined ? undefined : this.world.collections.find((c) => c.id === row.collectionId);
    return collection === undefined || collection.deleted ? undefined : row;
  }

  get(id: string): Promise<PageDetail | undefined> {
    const row = this.livePage(id);
    if (row === undefined) return Promise.resolve(undefined);
    const breadcrumb: { id: string; title: string }[] = [];
    for (let up = this.rows.find((r) => r.id === row.parentId); up !== undefined; up = this.rows.find((r) => r.id === up?.parentId)) breadcrumb.unshift({ id: up.id, title: up.title });
    return Promise.resolve({ ...this.meta(row), breadcrumb, markdownStaleSince: row.staleSince });
  }

  idOfUrlId(urlId: string): Promise<string | undefined> {
    return Promise.resolve(this.rows.find((r) => r.urlId === urlId)?.id);
  }

  updateMeta(id: string, patch: PageMetaPatch): Promise<PageMeta | undefined> {
    const row = this.livePage(id);
    if (row === undefined) return Promise.resolve(undefined);
    const title = patch.title ?? row.title;
    const next: Row = {
      ...row, title, icon: patch.icon === undefined ? row.icon : patch.icon, savedAt: row.savedAt + 1,
      hash: row.markdown === null ? row.hash : markdownHash(title, row.markdown),
    };
    this.rows[this.rows.indexOf(row)] = next;
    return Promise.resolve(this.meta(next));
  }

  private meta(row: Row): PageMeta {
    return {
      id: row.id, urlId: row.urlId, collectionId: row.collectionId, parentId: row.parentId, position: row.position, title: row.title, icon: row.icon,
      createdBy: row.createdBy, lastEditedBy: row.lastEditedBy, lastEditedAt: row.lastEditedAt, savedAt: row.savedAt, stateEpoch: row.stateEpoch,
    };
  }
}
