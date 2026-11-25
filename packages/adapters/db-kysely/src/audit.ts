import type { AuditEvent, AuditLog } from '@tektum/grimoire-core/ports/audit-log';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import { scoped } from './index.js';
import type { KyselyDatabase, OperatorDatabase } from './index.js';

/**
 * One audit row on `q`: pass a transaction handle so the row commits or rolls back with the change it describes.
 * The row is in the tenant the event names, else in the tenant of its actor, else (the system) in legacy.
 */
export async function insertAuditEvent(q: Queryable, event: AuditEvent): Promise<void> {
  await q.query(
    `insert into audit_events (actor_id, action, target_type, target_id, detail, tenant_id)
     values ($1, $2, $3, $4, $5::jsonb, coalesce($6::text, (select tenant_id from users where id = $1), 'legacy'))`,
    [event.actorId, event.action, event.targetType, event.targetId, event.detail === undefined ? null : JSON.stringify(event.detail), event.tenantId ?? null],
  );
}

/**
 * The PostgreSQL AuditLog over `audit_events`. The application role may insert and select there, never update or delete. An event that names its tenant is
 * written scoped to it; one that does not (the system, or an actor whose tenant only its row knows) runs on `ops`, the operator connection (docs/tenancy.md
 * section 3.2), which can read the actor's row in any tenant.
 */
export function createAudit(db: KyselyDatabase, ops: OperatorDatabase): AuditLog {
  return { append: (event) => (event.tenantId === undefined ? ops : scoped(db, event.tenantId)).transaction((tx) => insertAuditEvent(tx, event)) };
}
