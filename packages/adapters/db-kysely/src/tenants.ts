import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import type { OperatorDatabase } from './index.js';

/** The list of every tenant crosses tenants: it runs on `ops`, the operator connection (docs/tenancy.md section 3.2). Each tenant's work then goes through `scoped()`. */
export function createTenants(ops: OperatorDatabase): TenantRepo {
  return {
    async ids() {
      return (await ops.transaction((tx) => tx.query<{ id: string }>(`select id from tenants order by created_at, id`))).map((r) => r.id);
    },
  };
}
