const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

/** A tenant or an id that could change the path (a slash, dots, a space) is a fault of the caller, not input to clean: it throws. */
function part(value: string, shape: RegExp, what: string): string {
  if (!shape.test(value)) throw new Error(`import key: the ${what} is not one a key can hold`);
  return value;
}

/** Where the zip of an import is kept (M7 decision 2): under the tenant's own prefix. */
export const importZipKey = (tenantId: string, importId: string): string => `tenants/${part(tenantId, TENANT_ID, 'tenant id')}/imports/${part(importId, ID, 'import id')}/source.zip`;

/** Where zip number `ordinal` (from 0) of an import is kept: the first is `source.zip` (what the job reads), the others `source-<n>.zip`. */
export const importPartKey = (tenantId: string, importId: string, ordinal: number): string => {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 999) throw new Error('import key: the ordinal is not one a key can hold');
  return ordinal === 0 ? importZipKey(tenantId, importId) : `tenants/${part(tenantId, TENANT_ID, 'tenant id')}/imports/${part(importId, ID, 'import id')}/source-${String(ordinal)}.zip`;
};

/** Where the original Markdown of a page that failed is kept, for the person to download. */
export const importFailedKey = (tenantId: string, importId: string, itemId: string): string => `${importFailedPrefix(tenantId, importId)}${part(itemId, ID, 'item id')}.md`;

/** The prefix of every failed original of an import. */
export const importFailedPrefix = (tenantId: string, importId: string): string => `tenants/${part(tenantId, TENANT_ID, 'tenant id')}/imports/${part(importId, ID, 'import id')}/failed/`;
