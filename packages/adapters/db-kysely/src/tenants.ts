import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import type { KyselyDatabase } from './index.js';

export function createTenants(db: KyselyDatabase): TenantRepo {
  return {
    async ids() {
      return (await db.query<{ id: string }>(`select id from tenants order by created_at, id`)).map((r) => r.id);
    },
  };
}
