import { randomUUID } from 'node:crypto';
import type { ListedRevision, Revision, RevisionAuthor, RevisionListQuery, RevisionReason, RevisionRepo, RevisionSummary } from '../ports/revision-repo.js';

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

/** In-memory RevisionRepo for tests: newest first, ties by id, as the database orders them. */
export class FakeRevisionRepo implements RevisionRepo {
  private readonly rows: (Revision & { readonly pageId: string; readonly micros: number })[] = [];

  /** Test setup: a revision that exists. */
  seed(row: SeedRevision): Revision {
    const revision: Revision = {
      id: row.id ?? randomUUID(), createdAt: row.createdAt, title: row.title ?? 'Title', markdown: row.markdown ?? 'Text',
      authors: row.authors ?? [], lastAuthor: row.lastAuthor !== undefined ? row.lastAuthor : (row.authors?.at(-1) ?? null), reason: row.reason ?? 'idle',
    };
    this.rows.push({ ...revision, pageId: row.pageId, micros: row.createdAt * 1000 + (row.extraMicros ?? 0) });
    return revision;
  }

  list(pageId: string, query: RevisionListQuery): Promise<readonly ListedRevision[]> {
    const after = query.after;
    const rows = this.rows
      .filter((r) => r.pageId === pageId)
      .sort((a, b) => b.micros - a.micros || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((r) => after === undefined || r.micros < after[0] || (r.micros === after[0] && r.id > after[1]));
    return Promise.resolve(rows.slice(0, query.limit).map((r) => ({ ...summaryOf(r), sortKey: r.micros })));
  }

  get(pageId: string, revisionId: string): Promise<Revision | undefined> {
    const row = this.rows.find((r) => r.pageId === pageId && r.id === revisionId);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ ...summaryOf(row), markdown: row.markdown });
  }
}
