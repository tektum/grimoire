import type { RevisionRepo } from '@tektum/grimoire-core/ports/revision-repo';
import type { KyselyDatabase } from './index.js';

/** The PostgreSQL RevisionRepo. A skeleton: the owning task fills it in with the typed handle. */
export function createRevisions(db: KyselyDatabase): RevisionRepo {
  void db; // the owning task reads from it
  return {};
}
