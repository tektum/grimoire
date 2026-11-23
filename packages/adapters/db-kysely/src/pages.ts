import type { PageRepo } from '@tektum/grimoire-core/ports/page-repo';
import type { KyselyDatabase } from './index.js';

/** The PostgreSQL PageRepo. A skeleton: the owning task fills it in with the typed handle. */
export function createPages(db: KyselyDatabase): PageRepo {
  void db; // the owning task reads from it
  return {};
}
