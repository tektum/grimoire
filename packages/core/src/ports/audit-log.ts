/** One thing an administrator did. `detail` holds ids and values that are not secret, never page text or email addresses. */
export interface AuditEvent {
  readonly actorId: string | null;
  /** A fixed, dotted action name such as `collection.access_upserted`. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** The tenant the change happened in (docs/tenancy.md). Absent means `legacy`, the column default, until every writer names its tenant. */
  readonly tenantId?: string;
}

/** The audit trail: append only. There is no read, update or delete. Changes that carry an audit row write it in their own transaction (see `CollectionRepo`). */
export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}
