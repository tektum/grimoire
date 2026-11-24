import type { AuditEvent, AuditLog } from '@tektum/grimoire-core/ports/audit-log';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { KyselyDatabase } from './index.js';

/** One audit row on `q`: pass a transaction handle so the row commits or rolls back with the change it describes. */
export async function insertAuditEvent(q: Queryable, event: AuditEvent): Promise<void> {
  await q.query(
    `insert into audit_events (actor_id, action, target_type, target_id, detail, tenant_id) values ($1, $2, $3, $4, $5::jsonb, coalesce($6::text, 'legacy'))`,
    [event.actorId, event.action, event.targetType, event.targetId, event.detail === undefined ? null : JSON.stringify(event.detail), event.tenantId ?? null],
  );
}

/** The PostgreSQL AuditLog over `audit_events`. The application role may insert and select there, never update or delete. */
export function createAudit(db: KyselyDatabase): AuditLog {
  return { append: (event) => insertAuditEvent(db, event) };
}
