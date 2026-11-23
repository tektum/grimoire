import type { PageStateRepo } from '@tektum/grimoire-core/ports/page-state-repo';
import type { KyselyDatabase } from './index.js';

/** The PostgreSQL PageStateRepo. A skeleton: the owning task fills it in with the typed handle. */
export function createPageState(db: KyselyDatabase): PageStateRepo {
  void db; // the owning task reads from it
  return {};
}
