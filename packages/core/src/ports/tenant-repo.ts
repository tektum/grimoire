/** The tenants, for the jobs that work on every tenant in turn (docs/tenancy.md: no operator role at runtime). */
export interface TenantRepo {
  /** The ids of every tenant, oldest first. */
  ids(): Promise<readonly string[]>;
}
