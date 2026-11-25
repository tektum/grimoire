import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { ImportRepo } from '@tektum/grimoire-core/ports/import-repo';
import { RepoUnavailableError } from './search.js';

/** The imports table lands in M7-T04. */
export function createImportRepo(db: Queryable): ImportRepo {
  void db;
  return { get: () => Promise.reject(new RepoUnavailableError('imports', 'M7-T04')) };
}
