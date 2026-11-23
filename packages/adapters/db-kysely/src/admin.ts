import type { AdminRepo } from '@tektum/grimoire-core/ports/admin-repo';
import type { KyselyDatabase } from './index.js';

/** The PostgreSQL AdminRepo. A skeleton: the owning task fills it in with the typed handle. */
export function createAdmin(db: KyselyDatabase): AdminRepo {
  void db; // the owning task reads from it
  return {};
}
