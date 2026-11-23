import type { AuditLog } from '@tektum/grimoire-core/ports/audit-log';
import type { KyselyDatabase } from './index.js';

/** The PostgreSQL AuditLog. A skeleton: the owning task fills it in with the typed handle. */
export function createAudit(db: KyselyDatabase): AuditLog {
  void db; // the owning task reads from it
  return {};
}
