import type { AttachmentRow } from '../ports/attachment-repo.js';
import type { FileStorage } from '../ports/file-storage.js';
import { isInlineType } from './validate.js';

/** Seconds a download link works. It keeps working for that long after the reader loses access (documented in docs/files.md). */
export const DOWNLOAD_TTL_SECONDS = 300;

/**
 * What the signed link forces on the response, from the row alone, never from the request or from stored metadata (contracts section 6): a raster image is shown
 * inline under its own type unless a download was asked for; everything else, and a download, is an attachment, and a type that is not a raster image is served
 * as `application/octet-stream`, so no browser renders it or sniffs it.
 */
export function downloadOverrides(row: Pick<AttachmentRow, 'contentType'>, download: boolean): { readonly disposition: 'inline' | 'attachment'; readonly contentType: string } {
  if (!isInlineType(row.contentType)) return { disposition: 'attachment', contentType: 'application/octet-stream' };
  return { disposition: download ? 'attachment' : 'inline', contentType: row.contentType };
}

/** A signed download link for a ready row. */
export async function signedDownload(files: FileStorage, row: AttachmentRow, download: boolean): Promise<{ readonly url: string; readonly expiresAt: number }> {
  const { disposition, contentType } = downloadOverrides(row, download);
  return files.signDownload(row.key, { ttlSeconds: DOWNLOAD_TTL_SECONDS, disposition, fileName: row.fileName, contentType });
}
