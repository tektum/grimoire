import { cleanFileName } from './file-name.js';

/** The tenant of every row from before tenants (docs/tenancy.md); a row or a caller with none is this one. */
export const LEGACY = 'legacy';

const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The object key of an attachment: its id and nothing a user wrote. A tenant's attachments sit under its own prefix (docs/tenancy.md, 3.5); without a tenant the key is the one
 * that has always been used. A tenant id that could change the path (a slash, dots, a space) is a fault of the caller, not input to clean: it throws.
 */
export function attachmentKey(id: string, tenantId?: string): string {
  if (tenantId === undefined) return `attachments/${id}`;
  if (!TENANT_ID.test(tenantId)) throw new Error('attachment key: the tenant id is not one a key can hold');
  return `tenants/${tenantId}/attachments/${id}`;
}

/** The tenant a key sits under, or undefined for a key from before tenants. */
export function tenantOfKey(key: string): string | undefined {
  const m = /^tenants\/([^/]+)\/attachments\//.exec(key);
  return m?.[1];
}

/** `encodeURIComponent` leaves `! ' ( ) *` as they are; they end or open things in a Markdown link destination, so they are encoded too. */
const encodeSegment = (segment: string): string => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The path an editor writes into the Markdown of a page for an attachment: `attachments/<id>/<cleaned name>`, each segment percent-encoded, so a name with a space,
 * `#`, `%`, brackets, parentheses or a colon is still one relative path (a colon would otherwise read as a scheme) and survives the Markdown writer unchanged.
 */
export const markdownPathFor = (id: string, fileName: string): string => ['attachments', id, cleanFileName(fileName)].map(encodeSegment).join('/');
