import type { TrashRepo } from '@tektum/grimoire-core/ports/trash-repo';
import type { KyselyDatabase } from './index.js';

/** The PostgreSQL TrashRepo. A skeleton: the owning task fills it in with the typed handle. */
export function createTrash(db: KyselyDatabase): TrashRepo {
  void db; // the owning task reads from it
  return {};
}
