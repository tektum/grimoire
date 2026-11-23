import type { FilesConfig } from '@tektum/grimoire-core/ports/config';
import { S3FileStorage, type FileStorageOptions } from './storage.js';

export { S3FileStorage, type FileStorageOptions } from './storage.js';
export { mapError } from './errors.js';

/** The file store the server uses: the runtime identity, the internal endpoint, URLs signed for the public one. */
export function createFileStorage(config: FilesConfig, options?: FileStorageOptions): S3FileStorage {
  return new S3FileStorage(config, options);
}
