/** What an upload may be (spec R9.12, R9.14, R9.22): the type from an allow-list, the size within a limit, and which types the browser may show inline. */

export interface AttachmentLimits {
  /** Largest file in bytes. */
  readonly maxBytes: number;
  /** Lower-case media types an upload may declare, matched exactly. */
  readonly allowedTypes: readonly string[];
}

export type MetaRefusal = 'too_large' | 'type_not_allowed';
export type MetaResult = { readonly ok: true } | { readonly ok: false; readonly reason: MetaRefusal };

/**
 * The declared type is lower-cased and must be in the allow-list exactly (a parameter such as `; charset=utf-8` is not part of a match, and SVG and HTML are
 * never in the default list); then the size must not exceed the maximum. The type comes first, so a refused type is refused whatever its size. Sizes of zero or
 * less are the caller's to refuse (`invalid`): this answers only the two reasons the importer and the upload route share.
 */
export function validateAttachmentMeta(meta: { readonly size: number; readonly contentType: string }, limits: AttachmentLimits): MetaResult {
  if (!limits.allowedTypes.includes(meta.contentType.toLowerCase())) return { ok: false, reason: 'type_not_allowed' };
  if (meta.size > limits.maxBytes) return { ok: false, reason: 'too_large' };
  return { ok: true };
}

/** The raster types a browser may be given inline: a browser never turns an `image/*` response into a page. Every other type is downloaded. */
const INLINE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
/** The types whose first bytes are compared with the declared type when an upload completes (R9.22): the inline types and PDF. */
const CHECKED_TYPES: ReadonlySet<string> = new Set([...INLINE_TYPES, 'application/pdf']);

export const isInlineType = (contentType: string): boolean => INLINE_TYPES.has(contentType);
export const isCheckedType = (contentType: string): boolean => CHECKED_TYPES.has(contentType);

const OFFICE = 'application/vnd.openxmlformats-officedocument';
/** The extensions of the types of R9.14, lower-case; an importer uses it to give a file the type an upload of it would have declared. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
  docx: `${OFFICE}.wordprocessingml.document`,
  xlsx: `${OFFICE}.spreadsheetml.sheet`,
  pptx: `${OFFICE}.presentationml.presentation`,
  zip: 'application/zip',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** The media type of a file name by its extension, case-insensitively, or undefined when the extension is not one of the allowed types'. */
export function typeFromFileName(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return Object.hasOwn(BY_EXTENSION, name.slice(dot + 1).toLowerCase()) ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined;
}
