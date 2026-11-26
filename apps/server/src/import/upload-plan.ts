import type { ImportConfig } from '@tektum/grimoire-core/ports/config';
import { MAX_PARTS } from '@tektum/grimoire-core/ports/file-storage';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** From which size a zip goes up in parts, and how big a part is. */
export type UploadSizing = NonNullable<ImportConfig['uploadSizing']>;

/** One signed PUT carries a file under 4 GiB (a store takes 5 GiB in one request: the margin is for the headers and the signature); from 4 GiB a file goes up in parts of 64 MiB. */
export const DEFAULT_UPLOAD_SIZING: UploadSizing = { singleMaxBytes: 4 * GIB, partBytes: 64 * MIB };

/** The sizes in force: the setting of the config when there is one, the server's own otherwise. */
export const sizingOf = (config: ImportConfig): UploadSizing => config.uploadSizing ?? DEFAULT_UPLOAD_SIZING;

export type UploadPlan = { readonly kind: 'single' } | { readonly kind: 'multipart'; readonly partSize: number; readonly partCount: number };

/** How a file that goes up in parts is cut: parts of `partBytes`, larger (in whole MiB) when the file would need more parts than a store takes. */
export function cutParts(size: number, partBytes: number): { readonly partSize: number; readonly partCount: number } {
  const partSize = Math.max(partBytes, Math.ceil(size / MAX_PARTS / MIB) * MIB);
  return { partSize, partCount: Math.ceil(size / partSize) };
}

/** How a file of `size` bytes is sent: one signed PUT under the single-PUT size, parts from it up. */
export function planUpload(size: number, sizing: UploadSizing = DEFAULT_UPLOAD_SIZING): UploadPlan {
  return size < sizing.singleMaxBytes ? { kind: 'single' } : { kind: 'multipart', ...cutParts(size, sizing.partBytes) };
}

/** The exact length of part `partNumber` (from 1): the part size, but for the last part, which is what is left of the file. */
export const partLength = (size: number, partSize: number, partNumber: number): number => Math.min(partSize, size - (partNumber - 1) * partSize);
