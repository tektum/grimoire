export type ImportStatus = 'queued' | 'running' | 'finished' | 'failed' | 'cancelled' | 'expired';

export interface ImportRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly status: ImportStatus;
}

/** The imports of a workspace (M7 contracts section 4). Every read names the tenant: another tenant's import is not found. */
export interface ImportRepo {
  get(tenantId: string, id: string): Promise<ImportRecord | undefined>;
}
