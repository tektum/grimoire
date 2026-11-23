import type { AuditLog } from '../ports/audit-log.js';

/** In-memory AuditLog for tests. A skeleton: the task T05 fills it in. */
export class FakeAuditLog implements AuditLog {}
