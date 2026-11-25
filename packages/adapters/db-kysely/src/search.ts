import type { SearchRepo } from '@tektum/grimoire-core/ports/search-repo';
import type { Queryable } from '@tektum/grimoire-core/ports/database';

/** Thrown by a repository whose task has not been built yet, so a route that reaches it fails loudly instead of answering with nothing. */
export class RepoUnavailableError extends Error {
  constructor(what: string, task: string) {
    super(`${what} is not available yet (${task})`);
    this.name = 'RepoUnavailableError';
  }
}

/** The search query lands in M7-T01. */
export function createSearchRepo(db: Queryable): SearchRepo {
  void db;
  return { search: () => Promise.reject(new RepoUnavailableError('search', 'M7-T01')) };
}
