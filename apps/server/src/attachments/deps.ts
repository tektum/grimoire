import { fileTypeFromBuffer } from 'file-type';
import { v7 } from 'uuid';
import type { AttachmentDeps } from '@tektum/grimoire-core/attachments/uploads';
import type { AttachmentLimits } from '@tektum/grimoire-core/attachments/validate';
import { PartialFileDeletion } from '@tektum/grimoire-core/pages/purge';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import type { HttpDeps } from '../http/env.js';

/** The media type the first bytes of a file show (the `file-type` signatures), or undefined when they show none that is known. */
export const sniffType = async (bytes: Uint8Array): Promise<string | undefined> => (await fileTypeFromBuffer(bytes))?.mime;

/** The settings the upload rules read: the largest upload, the allowed types, and how many uploads a user may leave waiting. */
export type UploadLimits = AttachmentLimits & { readonly pendingMaxPerUser: number };

/** The use cases' dependencies and the limits, from the server's, or undefined when no file store (or no files settings) is configured. */
export function attachmentDeps(http: Pick<HttpDeps, 'attachments' | 'files' | 'clock' | 'config'>): { readonly deps: AttachmentDeps; readonly limits: UploadLimits } | undefined {
  const files = http.config.files;
  if (http.files === undefined || files === undefined) return undefined;
  const limits = { maxBytes: files.maxBytes, allowedTypes: files.allowedTypes, pendingMaxPerUser: files.pendingMaxPerUser };
  return { deps: { repo: http.attachments, files: http.files, now: () => http.clock.now(), newId: () => v7(), sniff: sniffType }, limits };
}

/**
 * What a purge calls with the keys of the attachments it is about to delete: the objects go first, one by one (a missing object is a success); without a store there is
 * nothing to remove. When the store fails part-way, the failure is `PartialFileDeletion` with the keys already removed, so the purge can mark their rows.
 */
export const deleteObjects = (files: FileStorage | undefined) => async (keys: readonly string[]): Promise<void> => {
  if (files === undefined) return;
  const removed: string[] = [];
  for (const key of keys) {
    try {
      await files.delete(key);
    } catch (error) {
      throw new PartialFileDeletion(removed, error);
    }
    removed.push(key);
  }
};
