import type { CollectionRepo } from '@tektum/grimoire-core/ports/collection-repo';
import type { KyselyDatabase } from './index.js';

/** The PostgreSQL CollectionRepo. A skeleton: the owning task fills it in with the typed handle. */
export function createCollections(db: KyselyDatabase): CollectionRepo {
  void db; // the owning task reads from it
  return {};
}
