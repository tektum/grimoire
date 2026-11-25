/** The payload of the import jobs: the tenant and the import, ids only (never a key, a URL, a name or Markdown; pg-boss payloads sit in tables the runtime role can read). */
export interface ImportPayload {
  readonly tenantId: string;
  readonly importId: string;
}

const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for exactly `{ tenantId, importId }` in their shapes. A handler drops and logs anything else. */
export function isImportPayload(value: unknown): value is ImportPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const v = value as Record<string, unknown>;
  return keys.length === 2 && typeof v['tenantId'] === 'string' && TENANT_ID.test(v['tenantId']) && typeof v['importId'] === 'string' && UUID.test(v['importId']);
}
