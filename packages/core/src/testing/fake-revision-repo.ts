import { randomUUID } from 'node:crypto';
import { markdownHash } from '../pages/hash.js';
import type { BeforeRestoreResult, CaughtUpRevision, ListedRevision, PageRevisionRequest, PageRevisionResult, Revision, RevisionAuthor, RevisionListQuery, RevisionReason, RevisionRepo, RevisionSummary } from '../ports/revision-repo.js';

export interface SeedRevision {
  readonly pageId: string;
  readonly createdAt: number;
  /** Extra microseconds beyond the millisecond, to play a time finer than the API shows. */
  readonly extraMicros?: number;
  readonly title?: string;
  readonly markdown?: string;
  readonly authors?: readonly RevisionAuthor[];
  readonly lastAuthor?: RevisionAuthor | null;
  readonly reason?: RevisionReason;
  readonly id?: string;
}

const summaryOf = (r: Revision): RevisionSummary => ({ id: r.id, createdAt: r.createdAt, title: r.title, lastAuthor: r.lastAuthor, authors: r.authors, reason: r.reason });

/** The saved state of a page as the fake sees it: what the database would read from `pages`. */
export interface FakePageState {
  readonly title: string;
  readonly markdown: string | null;
  readonly stale?: boolean;
  /** The page has editing state (`ydoc`). With no Markdown it counts as stale for a restore: its live content is saved nowhere else. */
  readonly hasState?: boolean;
  readonly lastEditedAt?: number | null;
  readonly lastEditedBy?: string | null;
}

/** In-memory RevisionRepo for tests: newest first, ties by id, as the database orders them. The revisions of a page of another tenant are absent. */
export class FakeRevisionRepo implements RevisionRepo {
  private readonly rows: (Revision & { readonly pageId: string; readonly micros: number; readonly hash: Buffer })[] = [];
  private readonly pageStates = new Map<string, FakePageState>();
  /** Test setup: the tenant of a page (`legacy` unless set). */
  readonly pageTenants = new Map<string, string>();
  /** Every call that reads or writes pages for revisions, in order: a test counts the database work with it. */
  readonly calls: string[] = [];
  /** Test setup: make the next `createFromPage` or `catchUp` reject with this. */
  failNext: Error | undefined;

  /** Test setup: a revision that exists. */
  seed(row: SeedRevision): Revision {
    const revision: Revision = {
      id: row.id ?? randomUUID(), createdAt: row.createdAt, title: row.title ?? 'Title', markdown: row.markdown ?? 'Text',
      authors: row.authors ?? [], lastAuthor: row.lastAuthor !== undefined ? row.lastAuthor : (row.authors?.at(-1) ?? null), reason: row.reason ?? 'idle',
    };
    this.rows.push({ ...revision, pageId: row.pageId, micros: row.createdAt * 1000 + (row.extraMicros ?? 0), hash: markdownHash(revision.title, revision.markdown) });
    return revision;
  }

  /** Test setup: the saved state of a page; a later call replaces it (a save, a title change, the stale flag set or cleared). */
  setPage(pageId: string, state: FakePageState): void {
    this.pageStates.set(pageId, state);
  }

  /** The revisions of a page, oldest first, with their reasons: what a test asserts on. */
  made(pageId: string): readonly { id: string; reason: RevisionReason; createdAt: number; title: string; markdown: string; authors: readonly string[]; lastAuthorId: string | null }[] {
    return this.rows.filter((r) => r.pageId === pageId).sort((a, b) => a.micros - b.micros)
      .map((r) => ({ id: r.id, reason: r.reason, createdAt: r.createdAt, title: r.title, markdown: r.markdown, authors: r.authors.map((a) => a.id), lastAuthorId: r.lastAuthor?.id ?? null }));
  }

  createFromPage(request: PageRevisionRequest): Promise<PageRevisionResult> {
    this.calls.push(`createFromPage:${request.pageId}`);
    if (this.failNext !== undefined) { const e = this.failNext; this.failNext = undefined; return Promise.reject(e); }
    const page = this.pageStates.get(request.pageId);
    if (page === undefined) return Promise.resolve({ kind: 'no-page' });
    if (page.stale === true) return Promise.resolve({ kind: 'stale' });
    if (page.markdown === null) return Promise.resolve({ kind: 'no-markdown' });
    const hash = markdownHash(page.title, page.markdown);
    const latest = this.rows.filter((r) => r.pageId === request.pageId).sort((a, b) => b.micros - a.micros)[0];
    if (latest !== undefined && latest.hash.equals(hash)) return Promise.resolve({ kind: 'unchanged' });
    // As the database does: a save newer than the caller's snapshot sets the date and the last editor.
    const later = page.lastEditedAt !== undefined && page.lastEditedAt !== null && page.lastEditedAt > request.at;
    const savedBy = later ? (page.lastEditedBy ?? null) : null;
    const ids = savedBy !== null && !request.authorIds.includes(savedBy) ? [...request.authorIds, savedBy] : request.authorIds;
    const lastId = savedBy ?? request.lastAuthorId;
    const created = this.seed({
      pageId: request.pageId, ...this.newest(request.pageId, later ? (page.lastEditedAt as number) : request.at), title: page.title, markdown: page.markdown, authors: ids.map((id) => ({ id, name: id })),
      lastAuthor: lastId === null ? null : { id: lastId, name: lastId }, reason: request.reason,
    });
    return Promise.resolve({ kind: 'created', id: created.id });
  }

  snapshotBeforeRestore(_tenantId: string, pageId: string): Promise<BeforeRestoreResult> {
    this.calls.push(`snapshotBeforeRestore:${pageId}`);
    if (this.failNext !== undefined) { const e = this.failNext; this.failNext = undefined; return Promise.reject(e); }
    const page = this.pageStates.get(pageId);
    if (page === undefined) return Promise.resolve({ kind: 'no-page' });
    if (page.stale === true || (page.markdown === null && page.hasState === true)) return Promise.resolve({ kind: 'stale' });
    if (page.markdown === null) return Promise.resolve({ kind: 'nothing-saved' });
    const latest = this.rows.filter((r) => r.pageId === pageId).sort((a, b) => b.micros - a.micros)[0];
    if (latest !== undefined && latest.hash.equals(markdownHash(page.title, page.markdown))) return Promise.resolve({ kind: 'existing', id: latest.id });
    const by = page.lastEditedBy ?? null;
    const created = this.seed({
      pageId, ...this.newest(pageId, page.lastEditedAt ?? Date.now()), title: page.title, markdown: page.markdown,
      authors: by === null ? [] : [{ id: by, name: by }], lastAuthor: by === null ? null : { id: by, name: by }, reason: 'before_restore',
    });
    return Promise.resolve({ kind: 'created', id: created.id });
  }

  catchUp(editedBefore: number, limit: number): Promise<readonly CaughtUpRevision[]> {
    this.calls.push('catchUp');
    if (this.failNext !== undefined) { const e = this.failNext; this.failNext = undefined; return Promise.reject(e); }
    const out: CaughtUpRevision[] = [];
    const due = [...this.pageStates].filter(([, p]) => p.stale !== true && p.markdown !== null && p.lastEditedAt !== undefined && p.lastEditedAt !== null && p.lastEditedAt < editedBefore)
      .sort((a, b) => (a[1].lastEditedAt as number) - (b[1].lastEditedAt as number));
    for (const [pageId, p] of due) {
      if (out.length >= limit) break;
      const latest = this.rows.filter((r) => r.pageId === pageId).sort((a, b) => b.micros - a.micros)[0];
      if (latest !== undefined && latest.hash.equals(markdownHash(p.title, p.markdown as string))) continue;
      const by = p.lastEditedBy ?? null;
      const revision = this.seed({ pageId, ...this.newest(pageId, p.lastEditedAt as number), title: p.title, markdown: p.markdown as string, authors: by === null ? [] : [{ id: by, name: by }], lastAuthor: by === null ? null : { id: by, name: by }, reason: 'idle' });
      out.push({ pageId, revisionId: revision.id });
    }
    return Promise.resolve(out);
  }

  /** A new revision sorts as the newest of its page, as in the database: never at or before the latest revision's time, by one microsecond. */
  private newest(pageId: string, wantedMs: number): { createdAt: number; extraMicros: number } {
    const latest = this.rows.filter((r) => r.pageId === pageId).reduce((m, r) => Math.max(m, r.micros), Number.NEGATIVE_INFINITY);
    const micros = Math.max(wantedMs * 1000, latest + 1);
    const createdAt = Math.floor(micros / 1000);
    return { createdAt, extraMicros: micros - createdAt * 1000 };
  }

  list(tenantId: string, pageId: string, query: RevisionListQuery): Promise<readonly ListedRevision[]> {
    const after = query.after;
    const rows = this.rows
      .filter((r) => r.pageId === pageId && (this.pageTenants.get(pageId) ?? 'legacy') === tenantId)
      .sort((a, b) => b.micros - a.micros || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((r) => after === undefined || r.micros < after[0] || (r.micros === after[0] && r.id > after[1]));
    return Promise.resolve(rows.slice(0, query.limit).map((r) => ({ ...summaryOf(r), sortKey: r.micros })));
  }

  get(tenantId: string, pageId: string, revisionId: string): Promise<Revision | undefined> {
    const row = this.rows.find((r) => r.pageId === pageId && r.id === revisionId && (this.pageTenants.get(pageId) ?? 'legacy') === tenantId);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ ...summaryOf(row), markdown: row.markdown });
  }
}
