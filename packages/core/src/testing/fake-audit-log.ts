import type { AuditEvent, AuditLog } from '../ports/audit-log.js';

/** In-memory AuditLog for tests: the events in the order they were appended. */
export class FakeAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];

  append(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
