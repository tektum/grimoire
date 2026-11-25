import type { TenantRepo } from '../ports/tenant-repo.js';

export class FakeTenantRepo implements TenantRepo {
  constructor(private readonly tenants: readonly string[] = []) {}

  ids(): Promise<readonly string[]> {
    return Promise.resolve(this.tenants);
  }
}
